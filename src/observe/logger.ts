import { observeBus } from "./bus.js";
import { getCtx } from "./als.js";
import { toErr } from "./errors.js";
import { JsonlSink } from "./jsonl-sink.js";
import { settings } from "../config/settings.js";
import type { LogLevel, LogPayload } from "./events.js";

// 双 sink：JSONL 落盘（规范 §3/§12）+ 实时观察总线（控制台 SSE）。
// ALS 提供日志归属（runId/threadId/agentId），无 context 时置 null，绝不抛。
// 生命周期事件（request/run/tool/llm/startup）用 logEvent() 显式给 event；
// 其余内部诊断走 logger.for(source).info(msg, data)，event 由 source+level 派生兜底。

const sink = new JsonlSink({
  dir: settings.LOG_DIR,
  appName: settings.appName,
  maxMb: settings.LOG_MAX_MB,
  retentionDays: settings.LOG_RETENTION_DAYS,
});

// ---- 脱敏 / 截断（规范 §10 红线 + 单字段/深度/数组上限）----
const SENSITIVE_KEY = /password|secret|token|authorization|credential|jwt|private.?key|api_?key/i;
const MAX_FIELD_LEN = 2000;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") {
    return (value as string).length > MAX_FIELD_LEN
      ? `${(value as string).slice(0, MAX_FIELD_LEN)}...`
      : value;
  }
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[Array len=${value.length}]`;
    const kept = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY) kept.push(`...(+${value.length - MAX_ARRAY})`);
    return kept;
  }
  if (t === "object") {
    if (depth >= MAX_DEPTH) return "[Object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// 把散落的 {err: string | Error} 统一规范成 {err:{type,code,message,stack}}（规范 §9）。
function normalizeErr(data: Record<string, unknown>): Record<string, unknown> {
  if (!data || typeof data !== "object") return data;
  const e = (data as Record<string, unknown>).err;
  if (e !== undefined && e !== null && (typeof e === "string" || e instanceof Error)) {
    return { ...data, err: toErr(e) };
  }
  return data;
}

// 派生事件名：source 转小写蛇形 + 级别后缀，供未显式指定 event 的调用兜底。
function snake(source: string): string {
  return source
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s./-]+/g, "_")
    .toLowerCase();
}

const LEVEL_RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

function enabled(level: LogLevel): boolean {
  const cfg = (settings.LOG_LEVEL || "info").toLowerCase();
  return (LEVEL_RANK[level] ?? 20) >= (LEVEL_RANK[cfg] ?? 20);
}

function emitLog(
  level: LogLevel,
  source: string,
  event: string,
  message: string,
  data?: Record<string, unknown>,
  traceId?: string | null
): void {
  if (!enabled(level)) return;
  const ctx = getCtx();
  const sanitized = sanitize(normalizeErr(data ?? {})) as Record<string, unknown> | undefined;
  const record: LogPayload & { v: number; ts: string } = {
    v: 1,
    ts: new Date().toISOString(),
    level,
    source,
    event,
    message,
    msg: message,
    ...(sanitized && Object.keys(sanitized).length ? { data: sanitized } : {}),
    app: settings.appName,
    env: settings.env,
    traceId: traceId ?? ctx?.traceId ?? null,
    runId: ctx?.runId ?? null,
    threadId: ctx?.threadId ?? null,
    agentId: ctx?.agentId ?? null,
  };

  sink.write(JSON.stringify(record), level === "error" || level === "fatal");

  const levelTag = level === "info" ? "" : `[${level}]`;
  const dataStr =
    sanitized && Object.keys(sanitized).length ? ` ${JSON.stringify(sanitized)}` : "";
  const line = `${levelTag}[${source}] ${message}${dataStr}`;
  if (level === "warn" || level === "error" || level === "fatal") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }

  observeBus.emit("logs", "log", record);
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// 模块顶部绑一次：const log = logger.for("tool"); 调用处 log.info("exec done", { ms: 120 })
export function forSource(source: string): Logger {
  const base = snake(source);
  return {
    debug: (m, d) => emitLog("debug", source, `${base}_debug`, m, d),
    info: (m, d) => emitLog("info", source, `${base}_info`, m, d),
    warn: (m, d) => emitLog("warn", source, `${base}_warn`, m, d),
    error: (m, d) => emitLog("error", source, `${base}_error`, m, d),
  };
}

export const logger = { for: forSource };

// 结构化生命周期事件（规范 §6）：显式 event + 人类 message + data，可选 traceId。
export interface EventLogInput {
  level: LogLevel;
  source: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  traceId?: string | null;
}

export function logEvent(input: EventLogInput): void {
  emitLog(input.level, input.source, input.event, input.message, input.data, input.traceId);
}
