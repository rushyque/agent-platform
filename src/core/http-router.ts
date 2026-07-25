// 项目 HTTP 路由注册表 —— 平台提供通用分发，项目自报前缀与处理函数。
// 这样平台核心无需 import 任何具体项目；项目（如星联工厂）在自己的模块里注册 /game 等路由。
import type http from "node:http";

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams
) => Promise<boolean>;

const handlers: Array<{ prefix: string; handle: RouteHandler }> = [];

export function registerProjectRoutes(prefix: string, handle: RouteHandler): void {
  handlers.push({ prefix, handle });
}

// 命中前缀则交给项目处理函数；返回 true 表示已写回响应
export async function handleProjectRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams
): Promise<boolean> {
  for (const h of handlers) {
    if (pathname === h.prefix || pathname.startsWith(h.prefix + "/")) {
      if (await h.handle(req, res, pathname, query)) return true;
    }
  }
  return false;
}
