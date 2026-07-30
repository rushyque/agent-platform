import { prisma } from "./prisma.js";
import { settings } from "../config/settings.js";
import { safeAppend } from "./db-safe.js";
import { logger } from "../observe/logger.js";

const log = logger.for("cleanup");

// TTL 自动清理：定期删超期的事件/审计/artifact（这三类大），防库无限增长。
// Thread/ThreadSummary 体量小，不在此清（删线程时 CASCADE 已清子表）。
// 失败经 safeAppend 不抛（DB 挂不影响主流程）。
// 保留期由 RETENTION_DAYS 配，缺省 30 天。

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 每 6h 跑一次
const FIRST_DELAY_MS = 5 * 60 * 1000; // 启动后 5min 跑首次（避开启动峰值）
const DEFAULT_RETENTION_DAYS = 30;

let timer: NodeJS.Timeout | null = null;

async function cleanupOnce(): Promise<void> {
  const days = settings.RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await safeAppend(
    "cleanup agent_events",
    () => prisma.agentEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    log
  );
  await safeAppend(
    "cleanup agent_runs",
    () => prisma.agentRun.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    log
  );
  await safeAppend(
    "cleanup artifacts",
    () => prisma.artifact.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    log
  );
  log.info("cleanup pass done", { retentionDays: days, cutoff: cutoff.toISOString() });
}

export function startCleanup(): void {
  if (timer) return;
  timer = setInterval(() => {
    void cleanupOnce();
  }, INTERVAL_MS);
  timer.unref?.(); // 不阻止进程退出
  setTimeout(() => {
    void cleanupOnce();
  }, FIRST_DELAY_MS).unref?.();
  log.info("cleanup scheduled", {
    intervalHours: INTERVAL_MS / 3_600_000,
    retentionDays: settings.RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS,
  });
}

export function stopCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
