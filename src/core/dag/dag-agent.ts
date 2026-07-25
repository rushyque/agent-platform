import { Observable } from "rxjs";
import { AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import type { LanguageModel } from "ai";
import type {
  DAGDefinition,
  ToolDefinition,
  AgentContext,
} from "../../types/agent-config.js";
import { executeDAG } from "./dag-executor.js";

export interface DAGAgentConfig {
  agentId: string;
  description: string;
  dagDefinition: DAGDefinition;
  tools: ToolDefinition[];
  context: AgentContext;
  createModel: () => LanguageModel;
  // 调试钩子：run 开始时回调，供平台层捕获决策元数据（/debug Trace 条用）
  onRunStart?: (input: RunAgentInput) => void;
}

// DAGAgent —— Harness 模式 Agent。
// 按 DAG 步骤确定性编排：llm / tool / condition / transform。
// 复杂多步任务（如月报生成）专用，继承 AG-UI AbstractAgent，与 Hermes 的 BuiltInAgent 共用同一套 runner / 持久化。
export class DAGAgent extends AbstractAgent {
  private dagDefinition: DAGDefinition;
  private tools: ToolDefinition[];
  private context: AgentContext;
  private createModelFn: () => LanguageModel;
  private onRunStartFn?: (input: RunAgentInput) => void;

  constructor(config: DAGAgentConfig) {
    super({ agentId: config.agentId, description: config.description });
    this.dagDefinition = config.dagDefinition;
    this.tools = config.tools;
    this.context = config.context;
    this.createModelFn = config.createModel;
    this.onRunStartFn = config.onRunStart;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: BaseEvent) => subscriber.next(event);

      const run = async () => {
        try { this.onRunStartFn?.(input); } catch { /* 调试钩子，永不阻断 */ }
        emit({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
          input,
        } as any);

        await executeDAG(this.dagDefinition, {
          threadId: input.threadId,
          runId: input.runId,
          messages: input.messages,
          context: this.context,
          tools: this.tools,
          createModel: this.createModelFn,
          emit,
          abortSignal: (input as any).abortSignal,
        });

        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as any);
        subscriber.complete();
      };

      run().catch((err) => {
        // executeDAG 已发射 RUN_ERROR；此处兜底确保有终止事件并 complete
        emit({
          type: EventType.RUN_ERROR,
          message: err instanceof Error ? err.message : String(err),
          code: "DAG_FATAL",
        } as any);
        subscriber.complete();
      });
    });
  }

  // AbstractAgent 的 clone() 用于 per-request 隔离（runtime 在 connect/handle 时会 clone）
  clone(): DAGAgent {
    return new DAGAgent({
      agentId: this.agentId!,
      description: this.description,
      dagDefinition: this.dagDefinition,
      tools: this.tools,
      context: this.context,
      createModel: this.createModelFn,
      onRunStart: this.onRunStartFn,
    });
  }
}
