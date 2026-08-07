// 观察层事件契约 —— 单条 SSE 多路复用，envelope 带 channel 标签。
// 这些类型同时约束后端生产者与（间接）前端消费。

export type Channel = "logs" | "runs" | "connections";

export interface Envelope<T = unknown> {
  channel: Channel;
  type: string;
  ts: number;
  payload: T;
  /** 回放环形缓冲里的历史事件时置 true，前端可据此区分"最近"与"实时"。 */
  replay?: boolean;
}

// ===== logs =====
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogPayload {
  level: LogLevel;
  source: string;
  msg: string;
  /** 机器聚合主键，小写蛇形（规范 §6）。调用方未显式给定事件名时由 source+level 派生。 */
  event: string;
  /** 人类一句话描述，与 msg 同值（规范 §8：message 不带裸数字，数字进 data）。 */
  message: string;
  /** 日志格式版本，v1（规范 §3.1）。 */
  v?: number;
  /** ISO 8601 UTC（规范 §3.1）。 */
  ts?: string;
  app?: string;
  env?: string;
  traceId?: string | null;
  data?: Record<string, unknown>;
  runId?: string | null;
  threadId?: string | null;
  agentId?: string | null;
}

// ===== runs =====
export interface RunContext {
  runId: string;
  threadId: string;
  agentId: string;
  userId?: string;
  route: "hermes" | "dag";
}

export interface RunStartedPayload extends RunContext {
  intent?: string;
  selectedTools?: string[];
  totalTools?: number;
  role?: string;
  model?: string;
}

export interface RunFinishedPayload {
  runId: string;
  threadId: string;
  agentId: string;
  status: "ok" | "error";
  durationMs: number;
  message?: string;
}

export interface RunLlmCallPayload {
  runId: string;
  threadId: string;
  agentId: string;
  systemPrompt: string;
  messages: unknown[];
  stepIndex: number;
}

export interface RunLlmResponsePayload {
  runId: string;
  threadId: string;
  agentId: string;
  rawText: string;
  usage?: { promptTokens?: number; completionTokens?: number } | null;
  finishReason?: string;
  stepIndex: number;
}

export interface RunToolCallPayload {
  runId: string;
  threadId: string;
  agentId: string;
  toolName: string;
  args: unknown;
}

export interface RunToolResultPayload {
  runId: string;
  threadId: string;
  agentId: string;
  toolName: string;
  execMs: number;
  summary: string;
  ref?: string | null;
}

export interface RunStepPayload {
  runId: string;
  threadId: string;
  agentId: string;
  stepIndex: number;
  type: "tool" | "llm" | "condition" | "transform";
  stepId?: string;
}

// ===== connections =====
export interface RequestStartedPayload {
  reqId: string;
  method: string;
  path: string;
  agentId?: string;
  userId?: string;
  ip?: string;
  origin?: string;
  ua?: string;
}

export interface RequestFinishedPayload {
  reqId: string;
  status: number;
  durationMs: number;
}
