// Shared helpers for SalesHub backend calls.
// Tools call the SalesHub NestJS `/api/*` endpoints with the user's original JWT,
// so role/salesperson scoping is enforced server-side (same as the web UI).
import type { AgentContext } from "../../../types/agent-config.js";

export interface SalesContext extends AgentContext {
  apiBase: string;
  token: string;
}

/** Build an absolute URL from a SalesHub API path (/api/...). */
export function hubUrl(ctx: SalesContext, path: string): string {
  return `${ctx.apiBase}${path}`;
}

/** Call a SalesHub API with the user's Bearer token. Returns parsed JSON or throws. */
export async function hubFetch<T = any>(
  ctx: SalesContext,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const resp = await fetch(hubUrl(ctx, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (resp.status === 401) {
    throw new Error("登录态已失效，请重新登录后再试");
  }
  if (!resp.ok) {
    // Non-2xx: let the platform wrap as a tool error (red "错误" envelope).
    throw new Error(`SalesHub 接口 ${resp.status}`);
  }
  return (await resp.json()) as T;
}
