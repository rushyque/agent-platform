// 星联模具工厂 —— 项目 HTTP 路由（/game）。
// 平台通过 registerProjectRoutes 注册；此文件依赖平台 core（auth/settings），不反向耦合。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signToken, verifyToken } from "../../core/middleware/auth.js";
import { settings } from "../../config/settings.js";
import { getGameState } from "./game/state-store.js";
import { subscribeGameChannel } from "./game/game-bus.js";
import type { RouteHandler } from "../../core/http-router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/projects/starlink-factory/ → 上三级到仓库根 → public
const PUBLIC_DIR = path.resolve(__dirname, "../../../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function authUserId(req: http.IncomingMessage): string | null {
  const h = (req.headers as any);
  const auth: string | undefined = h.authorization || h.Authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const decoded = verifyToken(auth.slice(7), settings.JWT_SECRET);
  return decoded?.userId ?? null;
}

export const starlinkFactoryRoutes: RouteHandler = async (req, res, pathname) => {
  // 测试用 dev-login：签发一个 manager JWT，前端用它既能驱动 agent 又能订阅游戏流。
  // 可传 body {userId} 复用稳定身份，使工厂（内存态）跨刷新保留。
  if (pathname === "/game/api/dev-login" && req.method === "POST") {
    let desired: string | undefined;
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (body && typeof body.userId === "string" && /^[a-zA-Z0-9_]{1,32}$/.test(body.userId)) {
        desired = body.userId;
      }
    } catch {
      /* 忽略非法 body */
    }
    const userId = desired ?? "manager_" + Math.random().toString(36).slice(2, 8);
    const token = signToken({ userId, role: "factory_manager" }, settings.JWT_SECRET);
    sendJson(res, 200, { token, userId });
    return true;
  }

  if (pathname === "/game/api/state") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" }), true;
    sendJson(res, 200, getGameState(userId));
    return true;
  }

  if (pathname === "/game/api/reset" && req.method === "POST") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" }), true;
    const { resetGameState } = await import("./game/state-store.js");
    const { emitGameEvent } = await import("./game/game-bus.js");
    const state = resetGameState(userId);
    emitGameEvent(userId, { kind: "reset", summary: "游戏已重置", snapshot: JSON.parse(JSON.stringify(state)) });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/game/api/stream") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" }), true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // 首推一次完整快照
    res.write(`data: ${JSON.stringify({ kind: "init", summary: "初始快照", snapshot: getGameState(userId) })}\n\n`);
    const unsub = subscribeGameChannel(userId, (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    });
    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on("close", () => {
      unsub();
      clearInterval(keepalive);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
    return true;
  }

  // 静态：/game → game.html，/game/<file> → public/<file>
  const rel = pathname === "/game" || pathname === "/game/" ? "game.html" : pathname.slice("/game/".length);
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return true;
  }
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
  return true;
};
