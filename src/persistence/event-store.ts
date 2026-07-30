import type { BaseEvent } from "@ag-ui/core";
import { prisma } from "./prisma.js";
import { safeAppend, safeRead } from "./db-safe.js";
import { logger } from "../observe/logger.js";

const log = logger.for("event-store");

// AG-UI 事件流存储 —— Prisma(ai_harness_db.agent_events)，append-only。
// connect() 重放、/debug 回放都读这里。重启不丢（曾用内存重启清空）。
// 写异步降级（persist 经 safeAppend 不阻塞 run），读失败降级 []（当新线程重放空历史）。

export interface EventRow {
  threadId: string;
  runId: string;
  agentId: string;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function appendEvents(meta: EventRow, events: BaseEvent[]): Promise<void> {
  if (!events.length) return;
  const rows = events.map((e) => ({
    threadId: meta.threadId,
    runId: meta.runId,
    agentId: meta.agentId,
    eventType: String((e as any).type ?? ""),
    payload: safeStringify(e),
  }));
  await safeAppend("appendEvents", () => prisma.agentEvent.createMany({ data: rows }), log);
}

// 按自增 id 升序重放 = 写入顺序（单进程内同线程 id 单调）。
export async function getEvents(threadId: string): Promise<BaseEvent[]> {
  const rows = await safeRead(
    () => prisma.agentEvent.findMany({ where: { threadId }, orderBy: [{ id: "asc" }] }),
    []
  );
  const events: BaseEvent[] = [];
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.payload);
      if (ev && typeof ev === "object") events.push(ev as BaseEvent);
    } catch {
      // 损坏行跳过
    }
  }
  return events;
}

export async function clearEvents(threadId: string): Promise<void> {
  await safeAppend(
    "clearEvents",
    () => prisma.agentEvent.deleteMany({ where: { threadId } }),
    log
  );
}
