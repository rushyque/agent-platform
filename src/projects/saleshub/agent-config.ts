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
    "SalesHub 销售系统助手：查询定单记录（含收款计划）、已审核汇款到账与冲红/预付对账报表，面向销售员/主管/管理员。",
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
  // 多步表单/页面动作编排时，模型会在一轮里多次调用只读的 get_page_state 去确认
  // "当前在哪一页、哪些动作可用"——这是正常且必要的自查，不属于"卡住重复"。
  // 因此把它从重复工具判定里排除（ignoreTools），只对真正的重复 UI 变更/填表兜底。
  // 同时把重复阈值放宽到 5，给多步编排更多余量，避免因"同一动作被至少重复 3 次"
  // 而误判卡住提前截断正常流程。
  loopGuard: {
    ignoreTools: ["get_page_state"],
    maxRepeatedToolCall: 5,
  },
  buildSystemPrompt: ({ context }) => buildSalesPrompt(context as SaleshubContext),
};
