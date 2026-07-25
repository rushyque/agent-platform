// 工具结果外置 —— 纯内存（会话级）。不落库。
// 一次对话内按 ref 取回即可，对话结束连同 thread 一起丢弃。中台不做长期记忆，
// DB 反而引入凭据/超时/降级问题（见测试报告），故用内存 Map。

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

interface Entry {
  record: ArtifactRecord;
  ts: number;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000; // 内存上限，超限淘汰最老（避免长会话无限增长）

function evict(): void {
  while (store.size > MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of store) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) store.delete(oldestKey);
    else break;
  }
}

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
  const record: ArtifactRecord = {
    ref,
    threadId: params.threadId ?? null,
    runId: params.runId ?? null,
    toolName: params.toolName,
    args: params.args ?? null,
    result: params.result,
    summary: (params.summary ?? "").slice(0, 1000) || null,
    createdAt: new Date(Date.now()).toISOString(),
  };
  store.set(ref, { record, ts: Date.now() });
  evict();
  return ref;
}

export async function getArtifact(ref: string): Promise<ArtifactRecord | null> {
  return store.get(ref)?.record ?? null;
}

export async function listArtifacts(opts?: {
  threadId?: string;
  runId?: string;
  limit?: number;
}): Promise<ArtifactRecord[]> {
  let arr = Array.from(store.values()).map((e) => e.record);
  if (opts?.threadId) arr = arr.filter((r) => r.threadId === opts.threadId);
  if (opts?.runId) arr = arr.filter((r) => r.runId === opts.runId);
  arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return arr.slice(0, opts?.limit ?? 100);
}
