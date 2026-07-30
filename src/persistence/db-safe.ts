import { logger } from "../observe/logger.js";

// DB 写/读的降级包装。统一主题：DB 慢/挂绝不阻塞 run 主流程、绝不抛进主流程。
// 这正是当初去 DB 的根因（凭据/超时/降级）——本次回 DB 必须正面治掉。

const WRITE_TIMEOUT_MS = 8_000; // 单次写最多 8s，超即视 DB 卡住

// 带超时的 await：超时 reject，交调用方 catch 走降级。
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// DB 写降级：超时或失败只记日志、不 re-throw（fire-and-forget 的 persist 依赖此不阻塞 run）。
// label 用于日志归属；log 传 logger.for(某 source)。
export async function safeAppend(
  label: string,
  run: () => Promise<unknown>,
  log: { error: (msg: string, data?: Record<string, unknown>) => void }
): Promise<void> {
  try {
    await withTimeout(run(), WRITE_TIMEOUT_MS, label);
  } catch (err) {
    log.error(`${label} failed (degraded, run continues)`, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// DB 读降级：失败返回 fallback（如 getEvents→[]、getArtifact→null）。
// 读不加额外超时——靠连接串 socketTimeout=15 兜底；这里只 catch。
export async function safeRead<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.for("DB-read").error("read failed, using fallback", {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
