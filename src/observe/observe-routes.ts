import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeBus } from "./bus.js";
import { settings } from "../config/settings.js";
import { getAllAgentIds, resolveAgent } from "../core/agent-router.js";
import { signToken } from "../core/middleware/auth.js";
import type { Channel, Envelope } from "./events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// console/ 是独立 Vite 工程，构建产物在 console/dist；未构建时静态分支自然 404。
// __dirname 在 tsx(源码) 与编译后(dist/) 都是 <root>/<src|dist>/observe，故 ../../console/dist 命中 <root>/console/dist。
const CONSOLE_DIST = path.resolve(__dirname, "../../console/dist");
const CHANNELS: Channel[] = ["logs", "runs", "connections"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// 可选 admin token：配置后，数据端点（stream / api）需带 ?token= 或 Authorization。
// 静态 /console 资源不门控，让 SPA 本身能加载、由前端把 token 附加到数据请求。
function tokenOk(req: http.IncomingMessage, query: URLSearchParams): boolean {
  if (!settings.OBSERVE_TOKEN) return true;
  const fromQuery = query.get("token");
  const fromHeader = (req.headers["authorization"] || "").toString().replace(/^Bearer\s+/i, "");
  return fromQuery === settings.OBSERVE_TOKEN || fromHeader === settings.OBSERVE_TOKEN;
}

export async function handleObserveRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams
): Promise<boolean> {
  const isObservePath =
    pathname === "/observe" ||
    pathname.startsWith("/observe/") ||
    pathname === "/console" ||
    pathname.startsWith("/console/");

  // 整层关闭：观察路径显式 404（避免落到 CopilotKit listener 产生奇怪响应）；
  // 非观察路径交回后续 handler。
  if (!settings.OBSERVE_ENABLED) {
    if (isObservePath) {
      sendJson(res, 404, { error: "observe disabled" });
      return true;
    }
    return false;
  }

  // ===== SSE 流 =====
  if (pathname === "/observe/stream") {
    if (!tokenOk(req, query)) {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (env: Envelope): boolean => {
      try {
        return res.write(`data: ${JSON.stringify(env)}\n\n`);
      } catch {
        return false;
      }
    };
    // 1) 回放每通道环形缓冲
    for (const ch of CHANNELS) {
      for (const env of observeBus.snapshot(ch)) {
        write({ ...env, replay: true });
      }
    }
    // 2) 续实时；写失败/客户端断开 → 退订并收尾，防订阅泄漏
    const unsub = observeBus.subscribe((env) => {
      const ok = write(env);
      if (!ok) {
        unsub();
        try { res.end(); } catch { /* swallow */ }
      }
    });
    req.on("close", () => {
      unsub();
      try { res.end(); } catch { /* swallow */ }
    });
    return true;
  }

  // ===== REST：agent 注册表 =====
  if (pathname === "/console/api/agents") {
    if (!tokenOk(req, query)) { sendJson(res, 403, { error: "forbidden" }); return true; }
    const agents = getAllAgentIds().map((id) => {
      const cfg = resolveAgent(id);
      return {
        id,
        description: cfg?.description ?? "",
        hasDag: !!cfg?.dagDefinition,
      };
    });
    sendJson(res, 200, { agents });
    return true;
  }

  // ===== REST：签发 JWT（Playground 身份模拟用） =====
  if (pathname === "/console/api/mint-token" && req.method === "POST") {
    if (!tokenOk(req, query)) { sendJson(res, 403, { error: "forbidden" }); return true; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return true;
    }
    const userId = String(body.userId || "anonymous");
    // verifyToken 读 id || userId || sub，这里用 id 对齐游戏前端 dev-login 约定
    const token = signToken(
      { id: userId, role: body.role, ...(body.claims || {}) },
      settings.JWT_SECRET
    );
    sendJson(res, 200, { token });
    return true;
  }

  // 其它 /console/api/* → 404（已知端点已在上面命中）
  if (pathname.startsWith("/console/api/")) {
    sendJson(res, 404, { error: "not found", path: pathname });
    return true;
  }

  // ===== 静态托管 console/dist（SPA，带 fallback） =====
  if (pathname === "/console" || pathname === "/console/" || pathname.startsWith("/console/")) {
    const rel =
      pathname === "/console" || pathname === "/console/"
        ? "index.html"
        : pathname.slice("/console/".length);
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(CONSOLE_DIST, safe);
    if (!filePath.startsWith(CONSOLE_DIST)) {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      // SPA fallback：未命中的子路径回 index.html（交给前端路由）
      try {
        const idx = await fs.promises.readFile(path.join(CONSOLE_DIST, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(idx);
      } catch {
        sendJson(res, 404, { error: "console not built", hint: "run: npm --prefix console run build" });
      }
    }
    return true;
  }

  return false;
}
