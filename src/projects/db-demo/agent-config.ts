// db-demo —— 中台通用工具层示例：连 ai_platform_db 的自然语言查询助手。
// 演示 coreTools.queryDatabase 开箱即用：AgentConfig.database 提供 backend，
// resolveContext 不必手动塞（中台 server 层自动注入 context.database）。
import type { AgentConfig } from "../../types/agent-config.js";
import { coreTools, createMssqlBackend } from "../../core/tools/index.js";

const backend = createMssqlBackend({ defaultLimit: 20 });

export const dbDemoAgentConfig: AgentConfig = {
  agentId: "db_demo",
  description: "数据库查询助手（中台通用工具层示例，连 ai_platform_db ERP 库）",
  resolveContext: async ({ userId, token }) => ({
    userId,
    role: "analyst",
    name: "数据查询助手",
    token,
  }),
  database: backend, // → 中台注入 context.database → query_database 取用
  tools: [
    coreTools.queryDatabase,
    coreTools.recall,
    coreTools.setNote,
    coreTools.getNote,
    coreTools.now,
  ],
  buildSystemPrompt: ({ context }) =>
    `你是${context.name}，帮用户用自然语言查询 ERP 数据库（订单/库存/客户/员工等）。\n` +
    `当前用户：${context.userId}（${context.role}）。\n` +
    `只读查询，绝不修改数据。查到关键数据可用 set_note 记下，避免重复查询。`,
};
