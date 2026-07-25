// DAG 检查点 —— 纯内存。允许 DAG 中断后从断点续跑。重启清空。
// （曾用 MSSQL agent_checkpoints 表。）

export interface Checkpoint {
  threadId: string;
  stepId: string;
  state: Record<string, any>;
}

const checkpoints = new Map<string, Checkpoint>();

export async function saveCheckpoint(
  threadId: string,
  stepId: string,
  state: Record<string, any>
): Promise<void> {
  checkpoints.set(threadId, { threadId, stepId, state });
}

export async function loadCheckpoint(threadId: string): Promise<Checkpoint | null> {
  return checkpoints.get(threadId) ?? null;
}

export async function clearCheckpoint(threadId: string): Promise<void> {
  checkpoints.delete(threadId);
}
