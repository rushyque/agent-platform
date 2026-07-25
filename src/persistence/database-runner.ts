import { ReplaySubject, Observable } from "rxjs";
import {
  AgentRunner,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from "@copilotkit/runtime/v2";
import { finalizeRunEvents } from "@copilotkit/shared";
import { EventType, compactEvents, type Message } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { appendEvents, getEvents } from "./event-store.js";
import { upsertThread, listThreads, type ThreadRecord } from "./thread-store.js";

// 每个线程的活跃状态（内存，用于并发 connect 转发 + stop）
interface ActiveState {
  subject: ReplaySubject<BaseEvent> | null; // 当前 run 的累计流，供 connect 实时转发
  isRunning: boolean;
  currentRunId: string | null;
  agent: AgentRunnerRunRequest["agent"] | null;
  stopRequested: boolean;
}

// DatabaseAgentRunner —— 替代 InMemoryAgentRunner。
// 事件流持久化到 MSSQL（agent_events），线程元数据持久化到 threads 表。
// connect() 从数据库重放历史 + 转发内存中正在进行的 run。
// 实现 LocalThreadEndpointRunner 接口，让 /threads/* 端点可用。
export class DatabaseAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true;

  private active = new Map<string, ActiveState>();

  constructor() {
    super();
  }

  private getOrCreate(threadId: string): ActiveState {
    let state = this.active.get(threadId);
    if (!state) {
      state = {
        subject: null,
        isRunning: false,
        currentRunId: null,
        agent: null,
        stopRequested: false,
      };
      this.active.set(threadId, state);
    }
    return state;
  }

  run(request: AgentRunnerRunRequest) {
    const state = this.getOrCreate(request.threadId);

    if (state.isRunning) {
      // 与 InMemoryAgentRunner 一致：默认禁止同线程并发 run
      throw new Error("Thread already running");
    }
    state.isRunning = true;
    state.currentRunId = request.input.runId;
    state.agent = request.agent;
    state.stopRequested = false;

    const currentRunEvents: BaseEvent[] = [];

    // 返回给调用方的 subject（仅本次 run）
    const runSubject = new ReplaySubject<BaseEvent>(Infinity);
    // 累计流 subject（供并发 connect 实时转发本次 run 事件）
    const nextSubject = new ReplaySubject<BaseEvent>(Infinity);
    state.subject = nextSubject;

    const runAgent = async () => {
      // 计算历史消息 id，用于从 RUN_STARTED 中剔除已见消息，避免重复回放
      const historicMessageIds = new Set<string>();
      try {
        const historicEvents = await getEvents(request.threadId);
        for (const event of historicEvents) {
          if ("messageId" in event && typeof event.messageId === "string") {
            historicMessageIds.add(event.messageId);
          }
          if (event.type === EventType.RUN_STARTED) {
            const messages = (event as any).input?.messages ?? [];
            for (const message of messages) if (message?.id) historicMessageIds.add(message.id);
          }
        }
      } catch (err) {
        console.error(`[DatabaseAgentRunner] load history failed for ${request.threadId}:`, (err as Error).message);
      }

      let lastDeltaTs = 0;
      let maxGap = 0;
      let gapsOver100 = 0;
      let gapsOver200 = 0;
      let deltaCount = 0;
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }: { event: BaseEvent }) => {
            if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
              deltaCount++;
              const now = Date.now();
              if (lastDeltaTs) {
                const gap = now - lastDeltaTs;
                if (gap > maxGap) maxGap = gap;
                if (gap > 100) gapsOver100++;
                if (gap > 200) gapsOver200++;
              }
              lastDeltaTs = now;
            }
            if (event.type === EventType.RUN_FINISHED) {
              console.log(`[sse-gaps] thread=${request.threadId} deltas=${deltaCount} maxGap=${maxGap}ms over100=${gapsOver100} over200=${gapsOver200}`);
            }
            let processed: BaseEvent = event;
            if (event.type === EventType.RUN_STARTED) {
              if (!(event as any).input) {
                const sanitizedMessages = request.input.messages
                  ? request.input.messages.filter((m: Message) => !historicMessageIds.has(m.id))
                  : undefined;
                const updatedInput = {
                  ...request.input,
                  ...(sanitizedMessages !== undefined ? { messages: sanitizedMessages } : {}),
                };
                processed = { ...(event as any), input: updatedInput };
              }
            }
            runSubject.next(processed);
            nextSubject.next(processed);
            currentRunEvents.push(processed);
          },
        });

        // 终止事件补全（若 agent 未自行发射 RUN_FINISHED/RUN_ERROR）
        const appended = finalizeRunEvents(currentRunEvents, {
          stopRequested: state.stopRequested,
        });
        for (const event of appended) {
          runSubject.next(event);
          nextSubject.next(event);
        }

        // 持久化（compacted 事件 + 线程元数据）；失败仅记日志，不阻断流
        await this.persist(request, currentRunEvents);
      } catch (error) {
        const interruptionMessage =
          error instanceof Error ? error.message : String(error);
        const appended = finalizeRunEvents(currentRunEvents, {
          stopRequested: state.stopRequested,
          interruptionMessage,
        });
        for (const event of appended) {
          runSubject.next(event);
          nextSubject.next(event);
        }
        try {
          if (currentRunEvents.length > 0) {
            await this.persist(request, currentRunEvents);
          }
        } catch (persistErr) {
          console.error(`[DatabaseAgentRunner] persist (error path) failed:`, (persistErr as Error).message);
        }
      } finally {
        if (state.currentRunId === request.input.runId) {
          state.isRunning = false;
          state.currentRunId = null;
          state.agent = null;
          state.subject = null;
          state.stopRequested = false;
        }
        runSubject.complete();
        nextSubject.complete();
      }
    };

    // 异步驱动，立即返回 observable
    runAgent();
    return runSubject.asObservable();
  }

  private async persist(
    request: AgentRunnerRunRequest,
    events: BaseEvent[]
  ): Promise<void> {
    const agentId = request.agent.agentId ?? "default";
    const compacted = compactEvents(events);
    await appendEvents(
      { threadId: request.threadId, runId: request.input.runId, agentId },
      compacted
    );
    await upsertThread({
      id: request.threadId,
      agentId,
      createdBy: (request.input as any).userId ?? null,
    });
  }

  connect(request: AgentRunnerConnectRequest) {
    return new Observable<BaseEvent>((subscriber) => {
      const connectionSubject = new ReplaySubject<BaseEvent>(Infinity);

      // 转发 connectionSubject → subscriber
      connectionSubject.subscribe({
        next: (event) => subscriber.next(event),
        complete: () => subscriber.complete(),
        error: (err) => subscriber.error(err),
      });

      const run = async () => {
        // 1. 从数据库重放全部历史
        let historyEvents: BaseEvent[] = [];
        try {
          historyEvents = await getEvents(request.threadId);
        } catch (err) {
          console.error(`[DatabaseAgentRunner] connect load failed:`, (err as Error).message);
        }
        const compacted = compactEvents(historyEvents);
        const emittedMessageIds = new Set<string>();
        for (const event of compacted) {
          connectionSubject.next(event);
          if ("messageId" in event && typeof event.messageId === "string") {
            emittedMessageIds.add(event.messageId);
          }
        }

        // 2. 若有正在进行的 run，转发其累计流（按 messageId 去重）
        const state = this.active.get(request.threadId);
        if (state?.subject && state.isRunning) {
          state.subject.subscribe({
            next: (event) => {
              if (
                "messageId" in event &&
                typeof event.messageId === "string" &&
                emittedMessageIds.has(event.messageId)
              ) {
                return;
              }
              connectionSubject.next(event);
            },
            complete: () => connectionSubject.complete(),
            error: (err) => connectionSubject.error(err),
          });
        } else {
          connectionSubject.complete();
        }
      };

      run().catch((err) => {
        if (!connectionSubject.closed) {
          connectionSubject.error(err);
        }
      });
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.active.get(request.threadId)?.isRunning ?? false;
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const state = this.active.get(request.threadId);
    if (!state || !state.isRunning) return false;
    if (state.stopRequested) return false;
    state.stopRequested = true;
    state.isRunning = false;
    const agent = state.agent;
    if (!agent) {
      state.stopRequested = false;
      return false;
    }
    try {
      agent.abortRun();
      return true;
    } catch (error) {
      console.error(`[DatabaseAgentRunner] abort failed:`, (error as Error).message);
      state.stopRequested = false;
      state.isRunning = true;
      return false;
    }
  }

  // ===== LocalThreadEndpointRunner：/threads/* 端点的本地回退 =====

  async listThreads(): Promise<LocalThreadEndpointRecord[]> {
    const threads: ThreadRecord[] = await listThreads();
    return threads.map((t) => ({
      id: t.id,
      name: t.title,
      agentId: t.agentId,
      organizationId: "",
      createdById: t.createdBy ?? "",
      archived: t.archived,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  }

  async getThreadMessages(threadId: string): Promise<Message[]> {
    // 最近一次 RUN_STARTED 的 input.messages 即该线程完整的消息历史快照
    const events = await getEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === EventType.RUN_STARTED) {
        const messages = (event as any).input?.messages;
        if (Array.isArray(messages)) return messages as Message[];
      }
    }
    return [];
  }

  async getThreadEvents(threadId: string): Promise<BaseEvent[]> {
    const events = await getEvents(threadId);
    return compactEvents(events);
  }

  async getThreadState(threadId: string): Promise<any> {
    const events = await this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === EventType.STATE_SNAPSHOT) {
        const snapshot = (event as any).snapshot;
        if (snapshot && typeof snapshot === "object") return snapshot;
        return null;
      }
    }
    return null;
  }
}
