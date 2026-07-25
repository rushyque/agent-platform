// 线程级滚动摘要（纯内存）。
// 每次 run 结束把"上次摘要 + 本次对话"压成新的单段摘要，覆写旧摘要（不累积多段）。
// 下次 run 开始注入到 system，作为该线程的延续上下文。原始历史不保留，对话结束即丢。
// 重启清空——中台不做长期记忆；需持久化可后续加文件兜底，不动本模块接口。

const summaries = new Map<string, string>();

export function getThreadSummary(threadId: string): string | null {
  return summaries.get(threadId) ?? null;
}

export function setThreadSummary(threadId: string, summary: string): void {
  const s = summary?.trim();
  if (s) summaries.set(threadId, s);
  else summaries.delete(threadId);
}
