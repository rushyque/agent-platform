import { prisma } from "./prisma.js";
import { safeAppend, safeRead } from "./db-safe.js";
import { logger } from "../observe/logger.js";

const log = logger.for("run-store");

// 运行审计 —— Prisma(ai_harness_db.agent_runs)。重启不丢。扩展字段支撑监控大盘。

export interface RunRecord {
  id: number; // BigInt→number（2^53 内安全；调试台 JSON 仍是 number）
  threadId: string;
  runId: string;
  agentId: string;
  userId: string | null;
  steps: number;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  finishReason: string | null;
  model: string | null;
  intent: string | null;
  status: string;
  createdAt: string;
}

function toDate(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function toRecord(r: {
  id: bigint;
  threadId: string;
  runId: string;
  agentId: string;
  userId: string | null;
  steps: number;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  finishReason: string | null;
  model: string | null;
  intent: string | null;
  status: string;
  createdAt: Date;
}): RunRecord {
  return {
    id: Number(r.id),
    threadId: r.threadId,
    runId: r.runId,
    agentId: r.agentId,
    userId: r.userId,
    steps: r.steps,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    durationMs: r.durationMs,
    finishReason: r.finishReason,
    model: r.model,
    intent: r.intent,
    status: r.status,
    createdAt: toDate(r.createdAt),
  };
}

// 列出审计行（最新优先）。可按 threadId 过滤、limit 截断（默认 200）。
export async function listRuns(opts?: {
  threadId?: string;
  limit?: number;
}): Promise<RunRecord[]> {
  const rows = await safeRead(
    () =>
      prisma.agentRun.findMany({
        where: opts?.threadId ? { threadId: opts.threadId } : undefined,
        orderBy: { id: "desc" },
        take: opts?.limit ?? 200,
      }),
    []
  );
  return rows.map(toRecord);
}

export async function recordRun(params: {
  threadId: string;
  runId: string;
  agentId: string;
  userId: string | null;
  steps: number;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs?: number | null;
  finishReason?: string | null;
  model?: string | null;
  intent?: string | null;
  status: string;
}): Promise<void> {
  await safeAppend(
    "recordRun",
    () =>
      prisma.agentRun.create({
        data: {
          threadId: params.threadId,
          runId: params.runId,
          agentId: params.agentId,
          userId: params.userId,
          steps: params.steps,
          promptTokens: params.promptTokens,
          completionTokens: params.completionTokens,
          durationMs: params.durationMs ?? null,
          finishReason: params.finishReason ?? null,
          model: params.model ?? null,
          intent: params.intent ?? null,
          status: params.status,
        },
      }),
    log
  );
}
