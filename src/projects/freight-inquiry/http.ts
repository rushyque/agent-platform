// Freight inquiry - project HTTP routes (/inquiry).
// 注册通过 registerProjectRoutes；只依赖平台核心（auth/settings），无反向耦合。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signToken, verifyToken } from "../../core/middleware/auth.js";
import { settings } from "../../config/settings.js";
import { getWorld, resetWorld, emitFreightWorld, subscribeFreightChannel } from "./state.js";
import type { RouteHandler } from "../../core/http-router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/projects/freight-inquiry/ -> 上三级到仓库根 -> public
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
  const h = req.headers as any;
  const auth: string | undefined = h.authorization || h.Authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const decoded = verifyToken(auth.slice(7), settings.JWT_SECRET);
  return decoded?.userId ?? null;
}

export const freightInquiryRoutes: RouteHandler = async (req, res, pathname) => {
  // Dev login: 发放一个销售 JWT，可选 body {userId} 复用身份
  if (pathname === "/inquiry/api/dev-login" && req.method === "POST") {
    let desired: string | undefined;
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (body && typeof body.userId === "string" && /^[a-zA-Z0-9_]{1,32}$/.test(body.userId)) {
        desired = body.userId;
      }
    } catch {
      /* ignore */
    }
    const userId = desired ?? "sales_" + Math.random().toString(36).slice(2, 8);
    const token = signToken({ userId, role: "customer" }, settings.JWT_SECRET);
    sendJson(res, 200, { token, userId });
    return true;
  }

  // 全量世界状态（前端拉取/初始化用）
  if (pathname === "/inquiry/api/world") {
    const userId = authUserId(req);
    if (!userId) return (sendJson(res, 401, { error: "unauthorized" }), true);
    sendJson(res, 200, getWorld(userId));
    return true;
  }

  if (pathname === "/inquiry/api/reset" && req.method === "POST") {
    const userId = authUserId(req);
    if (!userId) return (sendJson(res, 401, { error: "unauthorized" }), true);
    resetWorld(userId);
    emitFreightWorld(userId, "已重置");
    sendJson(res, 200, { ok: true });
    return true;
  }

  // SSE 状态推送
  if (pathname === "/inquiry/api/stream") {
    const userId = authUserId(req);
    if (!userId) return (sendJson(res, 401, { error: "unauthorized" }), true);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify({ type: "world", summary: "initial snapshot", world: getWorld(userId) })}\n\n`);
    const unsub = subscribeFreightChannel(userId, (evt) => {
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

  // 静态：/inquiry -> inquiry.html，/inquiry/<file> -> public/<file>
  const rel = pathname === "/inquiry" || pathname === "/inquiry/" ? "inquiry.html" : pathname.slice("/inquiry/".length);
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
