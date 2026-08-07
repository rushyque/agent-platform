import { settings } from "../config/settings.js";

// 符合《高质量日志规范》§9 的错误结构：{type, code, message, stack}
// type = 业务错误分类（稳定、可聚合）；code = 系统/驱动错误码；stack 只在 debug 落盘。
export interface ErrRecord {
  type: string;
  code?: string;
  message: string;
  stack?: string;
}

// 把任意抛出的值规范成 ErrRecord。已经是 {type,...} 结构的对象原样透传（仅补缺省）。
export function toErr(err: unknown, fallbackType = "UNKNOWN"): ErrRecord {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; type?: unknown };
    return {
      type: String(e.type || fallbackType),
      ...(e.code ? { code: String(e.code) } : {}),
      message: e.message || String(err),
      ...(settings.LOG_LEVEL === "debug" && e.stack ? { stack: e.stack } : {}),
    };
  }
  if (typeof err === "string") {
    return { type: fallbackType, message: err };
  }
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const type = o.type ? String(o.type) : fallbackType;
    return {
      type,
      ...(o.code ? { code: String(o.code) } : {}),
      message:
        typeof o.message === "string"
          ? o.message
          : (() => {
              try {
                return JSON.stringify(err);
              } catch {
                return String(err);
              }
            })(),
      ...(settings.LOG_LEVEL === "debug" && typeof o.stack === "string"
        ? { stack: o.stack }
        : {}),
    };
  }
  return { type: fallbackType, message: String(err) };
}
