// SalesHub — AgentConfig for the SalesHub business system assistant.
// Tools call SalesHub's own NestJS /api/* endpoints with the user's JWT,
// so data scoping (salesperson / role) is enforced by SalesHub server-side.
import jwt from "jsonwebtoken";
import type { AgentConfig } from "../../types/agent-config.js";
import { salesHubTools } from "./tools/index.js";
import { buildSalesPrompt, type SaleshubContext } from "./prompts.js";
import { classifySalesIntent } from "./intent.js";

// SalesHub backend base URL. Honors existing SALESHUB_BACKEND_URL convention.
const DEFAULT_API_BASE =
  process.env.SALESHUB_BACKEND_URL ||
  process.env.SALESHUB_API_BASE ||
  "http://localhost:3001";

export const saleshubAgentConfig: AgentConfig = {
  agentId: "saleshub",
  description:
    "SalesHub 销售系统助手：查询订单（含收款计划/收款记录）与客户、客户订单，面向销售员/主管/管理员。",
  resolveContext: async ({ userId, token }) => {
    // Token was already verified by the platform. Decode claims to get the
    // display name + role that SalesHub embedded at login (full_name / role).
    let displayName = userId;
    let role = "user";
    if (token) {
      try {
        const decoded = jwt.decode(token) as any;
        if (decoded?.full_name) displayName = String(decoded.full_name);
        if (decoded?.role) role = String(decoded.role);
      } catch {
        // non-fatal: fall back to userId
      }
    }
    const roleText =
      role === "admin"
        ? "管理员"
        : role === "remittance_manager"
          ? "汇款主管"
          : "销售员";
    const ctx: SaleshubContext = {
      userId,
      token,
      apiBase: DEFAULT_API_BASE,
      displayName,
      roleText,
    };
    return ctx;
  },
  tools: salesHubTools,
  // 开放性问题（起草/解释/建议/头脑风暴）不走工具、提温释放表达；数据查询类低温保真走工具。
  classifyIntent: classifySalesIntent,
  intentTemperature: {
    query: 0.2,
    general: 0.7,
  },
  buildSystemPrompt: ({ context }) => buildSalesPrompt(context as SaleshubContext),
};
