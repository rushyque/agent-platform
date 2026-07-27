import { observeBus } from "./bus.js";
import { getCtx } from "./als.js";
import type { LogLevel } from "./events.js";

// 双 sink：stdout（保留终端输出，对齐现有 `[source] msg` 风格）+ observe bus 的 logs 通道。
// ALS 提供日志归属（runId/threadId/agentId），无 context 时三字段置 null，绝不抛。
function emitLog(
  level: LogLevel,
  source: string,
  msg: string,
  data?: Record<string, unknown>
): void {
  const ctx = getCtx();
  const payload = {
    level,
    source,
    msg,
    ...(data ? { data } : {}),
    runId: ctx?.runId ?? null,
    threadId: ctx?.threadId ?? null,
    agentId: ctx?.agentId ?? null,
  };

  const levelTag = level === "info" ? "" : `[${level}]`;
  const dataStr = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
  const line = `${levelTag}[${source}] ${msg}${dataStr}`;
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }

  observeBus.emit("logs", "log", payload);
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// 模块顶部绑一次：const log = logger.for("tool"); 调用处 log.info("exec done", { ms: 120 })
export function forSource(source: string): Logger {
  return {
    debug: (m, d) => emitLog("debug", source, m, d),
    info: (m, d) => emitLog("info", source, m, d),
    warn: (m, d) => emitLog("warn", source, m, d),
    error: (m, d) => emitLog("error", source, m, d),
  };
}

export const logger = { for: forSource };
