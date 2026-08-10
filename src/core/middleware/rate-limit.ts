import { settings } from "../../config/settings.js";
import { logEvent } from "../../observe/index.js";

/**
 * 内存版滑动窗口限流（进程外置可选）。
 *
 * 中台是 Node http 服务器，无现成限流中间件；这里用固定窗口计数 +
 * 每 IP 并发上限做基础防滥用：
 * - 所有请求（含健康检查/静态）受 RATE_LIMIT_WINDOW / RATE_LIMIT_MAX 约束；
 * - /agent/*（LLM）入口额外受 RATE_LIMIT_AGENT_MAX 的窗口配额约束；
 * - RATE_LIMIT_CONCURRENCY 限制同时在跑的 LLM 请求并发数（滑动窗口不覆盖长连接，
 *   并发计数兜底）。
 *
 * 特征：纯内存、重启即清零，适合私有内网；分布式部署时应替换为 Redis。
 */

interface WindowState {
  windowStart: number;
  count: number;
}

const windowMs = settings.RATE_LIMIT_WINDOW_MS;
const maxPerWindow = settings.RATE_LIMIT_MAX;
const agentMaxPerWindow = settings.RATE_LIMIT_AGENT_MAX;

const windows = new Map<string, WindowState>();
let inflight = 0;

function windowKey(ip: string): string {
  return ip || "unknown";
}

function consume(ip: string, limit: number): boolean {
  const key = windowKey(ip);
  const now = Date.now();
  const cur = windows.get(key);
  if (!cur || now - cur.windowStart >= windowMs) {
    windows.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= limit) {
    return false;
  }
  cur.count += 1;
  return true;
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, state] of windows) {
    if (now - state.windowStart >= windowMs) {
      windows.delete(key);
    }
  }
  if (windows.size > 10000) {
    windows.clear();
  }
}

export interface RateLimitResult {
  allowed: boolean;
  status: number;
  message: string;
  retryAfterMs: number;
}

export function checkRateLimit(req: { url?: string }, ip: string): RateLimitResult {
  cleanup();
  const url = req.url || "/";
  const isAgent = url.startsWith("/agent/");

  // 每 IP 滑动窗口基础配额
  if (!consume(ip, maxPerWindow)) {
    return {
      allowed: false,
      status: 429,
      message: "请求过于频繁，请稍后再试",
      retryAfterMs: windowMs,
    };
  }

  // LLM 入口额外配额（更严）
  if (isAgent && !consume(`agent:${windowKey(ip)}`, agentMaxPerWindow)) {
    return {
      allowed: false,
      status: 429,
      message: "当前访问过于频繁，请稍后再试",
      retryAfterMs: windowMs,
    };
  }

  // 全局并发上限（覆盖所有请求，防熔断）
  if (inflight >= settings.RATE_LIMIT_CONCURRENCY) {
    return {
      allowed: false,
      status: 503,
      message: "服务繁忙，请稍后再试",
      retryAfterMs: 1000,
    };
  }
  return { allowed: true, status: 200, message: "", retryAfterMs: 0 };
}

export function trackStart(): void {
  inflight += 1;
}

export function trackEnd(): void {
  if (inflight > 0) inflight -= 1;
}

export function rateLimitLog(ip: string, url: string, status: number, message: string): void {
  logEvent({
    level: "warn",
    source: "limit",
    event: "rate_limited",
    message,
    data: { ip, path: url, status },
  });
}
