import { prisma } from "../../persistence/prisma.js";
import { logger } from "../../observe/logger.js";

const log = logger.for("artifact-store");

// 默认工具结果摘要上限（与 CompactionPolicy.toolResultSummaryChars 对齐；
// 在此单列以避免 stageToolResult 反向依赖 policy）。
const DEFAULT_TOOL_SUMMARY_CHARS = 200;

// 工具结果外置 —— Prisma(ai_harness_db.artifacts) + 内存 LRU 热缓存。
// getArtifact 高频被模型调用 → 内存命中省 DB 随机读，未命中查 DB 回填。
// 写：内存立即存（保证外置 ref 一定能取回，与 server.ts 降级语义一致），DB 写 fire-and-forget
//     不阻塞工具返回；DB 失败只记日志（已在内存，不丢）。
// result 是 JSON 文本（sqlserver 无 Json 类型），应用层 stringify/parse。

export interface ArtifactRecord {
  ref: string;
  threadId: string | null;
  runId: string | null;
  toolName: string;
  args: unknown;
  result: unknown;
  summary: string | null;
  createdAt: string;
}

// ---- 内存热缓存（LRU）----
interface CacheEntry {
  record: ArtifactRecord;
  ts: number;
}
const cache = new Map<string, CacheEntry>();
const MAX_CACHE = 2000;

function cacheGet(ref: string): ArtifactRecord | null {
  const e = cache.get(ref);
  if (!e) return null;
  e.ts = Date.now();
  return e.record;
}
function cacheSet(record: ArtifactRecord): void {
  cache.set(record.ref, { record, ts: Date.now() });
  while (cache.size > MAX_CACHE) {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldest = k;
      }
    }
    if (oldest) cache.delete(oldest);
    else break;
  }
}

// ---- helpers ----
let counter = 0;
function newRef(): string {
  counter++;
  return `art-${Date.now().toString(36)}-${counter.toString(36)}`;
}
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function parseJson(s: string | null): unknown {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function toDate(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// 提取工具结果的"摘要文本"：优先取业务字段（trace/message/summary/error），
// 否则序列化后截断。用于外置时的 summary + 折叠占位，让模型只看到精简结论。
export function summarizeToolResult(result: unknown, maxChars: number): string {
  let text: string;
  if (result == null) {
    text = "";
  } else if (typeof result === "string") {
    text = result;
  } else if (typeof result === "object") {
    const r = result as Record<string, any>;
    const prefer = r.trace ?? r.summary ?? r.message ?? r.error ?? r.detail ?? r.data;
    if (prefer != null) {
      text = typeof prefer === "string" ? prefer : safeStringify(prefer);
    } else {
      text = safeStringify(result);
    }
  } else {
    text = String(result);
  }
  if (text.length > maxChars) {
    return text.slice(0, maxChars) + "…";
  }
  return text;
}

export async function insertArtifact(params: {
  threadId?: string | null;
  runId?: string | null;
  toolName: string;
  args?: unknown;
  result: unknown;
  summary?: string | null;
}): Promise<string> {
  const ref = newRef();
  const summary = (params.summary ?? "").slice(0, 1000) || null;
  const record: ArtifactRecord = {
    ref,
    threadId: params.threadId ?? null,
    runId: params.runId ?? null,
    toolName: params.toolName,
    args: params.args ?? null,
    result: params.result,
    summary,
    createdAt: new Date(Date.now()).toISOString(),
  };
  // 内存立即存（无论 DB 是否成功，ref 都能取回）
  cacheSet(record);
  // DB 持久 fire-and-forget：不阻塞工具返回；失败只记日志（内存已有，不丢）
  void prisma.artifact
    .create({
      data: {
        ref,
        threadId: params.threadId ?? null,
        runId: params.runId ?? null,
        toolName: params.toolName,
        args: safeStringify(params.args ?? null),
        result: safeStringify(params.result),
        summary,
      },
    })
    .catch((err: unknown) => {
      log.error("insertArtifact db write failed (degraded, kept in memory)", {
        ref,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  return ref;
}

export async function getArtifact(ref: string): Promise<ArtifactRecord | null> {
  const hit = cacheGet(ref);
  if (hit) return hit;
  try {
    const row = await prisma.artifact.findUnique({ where: { ref } });
    if (!row) return null;
    const record: ArtifactRecord = {
      ref: row.ref,
      threadId: row.threadId,
      runId: row.runId,
      toolName: row.toolName,
      args: parseJson(row.args),
      result: parseJson(row.result),
      summary: row.summary,
      createdAt: toDate(row.createdAt),
    };
    cacheSet(record);
    return record;
  } catch (err) {
    log.error("getArtifact read failed (degraded)", {
      ref,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function listArtifacts(opts?: {
  threadId?: string;
  runId?: string;
  limit?: number;
}): Promise<ArtifactRecord[]> {
  try {
    const rows = await prisma.artifact.findMany({
      where: {
        ...(opts?.threadId ? { threadId: opts.threadId } : {}),
        ...(opts?.runId ? { runId: opts.runId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: opts?.limit ?? 100,
    });
    return rows.map((r) => ({
      ref: r.ref,
      threadId: r.threadId,
      runId: r.runId,
      toolName: r.toolName,
      args: parseJson(r.args),
      result: parseJson(r.result),
      summary: r.summary,
      createdAt: toDate(r.createdAt),
    }));
  } catch (err) {
    log.error("listArtifacts read failed (degraded)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---- 工具结果分级（内联 vs 外置）----
//
// 编排层（领域工具行数/列投影 + run_sql TOP 上限）已保证结果尺度小，默认把结果
// 完整内联回上下文，模型拿到全量数据即可直接作答，不必重查/取回（治"折叠→重查"
// 绕圈）。仅当结果串行化超过预算时，才外置为 {ref, summary, full:false} 安全阀。
// Hermes（server.ts）与 DAG（dag-executor.ts）共用，保证两条链路一致。

export interface StageResult {
  /** true → 调用方应把原始 result 完整内联给模型（已含全量数据） */
  inline: boolean;
  /** 外置成功时的 ref；inline=true 时为 null */
  ref: string | null;
  /** 工具结果的摘要文本（内联时也计算，供 trace/审计展示用） */
  summary: string;
}

export async function stageToolResult(result: unknown, opts: {
  maxInlineChars: number;
  threadId?: string | null;
  runId?: string | null;
  toolName: string;
  args?: unknown;
  summaryChars?: number;
}): Promise<StageResult> {
  const summary = summarizeToolResult(
    result,
    opts.summaryChars ?? DEFAULT_TOOL_SUMMARY_CHARS
  );
  let size = 0;
  try {
    size = safeStringify(result).length;
  } catch {
    size = Number.MAX_SAFE_INTEGER;
  }
  if (size <= opts.maxInlineChars) {
    return { inline: true, ref: null, summary };
  }
  try {
    const ref = await insertArtifact({
      threadId: opts.threadId ?? null,
      runId: opts.runId ?? null,
      toolName: opts.toolName,
      args: opts.args,
      result,
      summary,
    });
    return { inline: false, ref, summary };
  } catch (err) {
    logger.for("artifact").error("stageToolResult insert failed", {
      tool: opts.toolName,
      err: err instanceof Error ? err.message : String(err),
    });
    // 外置失败 → 降级内联，绝不阻塞工具调用。
    return { inline: true, ref: null, summary };
  }
}
