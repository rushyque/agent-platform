// 运行审计 —— 纯内存。重启清空。（曾用 MSSQL agent_runs 表。）

export interface RunRecord {
  id: number;
  threadId: string;
  runId: string;
  agentId: string;
  userId: string | null;
  steps: number;
  promptTokens: number | null;
  completionTokens: number | null;
  status: string;
  createdAt: string;
}

const runs: RunRecord[] = [];
let idCounter = 0;

// 列出审计行（最新优先）。可按 threadId 过滤、limit 截断（默认 200）。
export async function listRuns(opts?: {
  threadId?: string;
  limit?: number;
}): Promise<RunRecord[]> {
  let arr = runs.slice().sort((a, b) => b.id - a.id);
  if (opts?.threadId) arr = arr.filter((r) => r.threadId === opts.threadId);
  return arr.slice(0, opts?.limit ?? 200);
}

export async function recordRun(params: {
  threadId: string;
  runId: string;
  agentId: string;
  userId: string | null;
  steps: number;
  promptTokens: number | null;
  completionTokens: number | null;
  status: string;
}): Promise<void> {
  idCounter++;
  runs.push({
    id: idCounter,
    threadId: params.threadId,
    runId: params.runId,
    agentId: params.agentId,
    userId: params.userId,
    steps: params.steps,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    status: params.status,
    createdAt: new Date(Date.now()).toISOString(),
  });
}
