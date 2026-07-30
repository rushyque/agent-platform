import { prisma } from "../../persistence/prisma.js";
import { logger } from "../../observe/logger.js";

const log = logger.for("thread-memory");

// 线程级滚动摘要 —— 内存 Map 为同步读源 + Prisma 持久（write-through）。
// getThreadSummary/setThreadSummary 保持同步接口（server.ts factory 同步调）。
// 写：内存即时更新 + 异步 upsert DB；启动从 DB 全量加载（loadThreadSummariesFromDb）。
// 降级：启动加载失败→内存空（当新线程，下次 run rollup 覆写）；DB upsert 失败→内存仍最新。

const summaries = new Map<string, string>();

// 启动期全量加载（write-through 预热）。失败降级为空内存，不抛。
export async function loadThreadSummariesFromDb(): Promise<void> {
  try {
    const rows = await prisma.threadSummary.findMany();
    for (const r of rows) if (r.summary) summaries.set(r.threadId, r.summary);
    log.info("thread summaries loaded", { count: rows.length });
  } catch (err) {
    log.error("load summaries failed, continuing with empty memory", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getThreadSummary(threadId: string): string | null {
  return summaries.get(threadId) ?? null;
}

export function setThreadSummary(threadId: string, summary: string): void {
  const s = summary?.trim();
  if (s) summaries.set(threadId, s);
  else summaries.delete(threadId);
  // 异步落库，失败只记日志、不抛（内存已是最新，下次 run rollup 会再覆写）
  void persistSummary(threadId, s).catch((err: unknown) =>
    log.error("persist summary failed", {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    })
  );
}

async function persistSummary(threadId: string, s: string | null): Promise<void> {
  if (s) {
    await prisma.threadSummary.upsert({
      where: { threadId },
      create: { threadId, summary: s },
      update: { summary: s },
    });
  } else {
    await prisma.threadSummary.deleteMany({ where: { threadId } });
  }
}
