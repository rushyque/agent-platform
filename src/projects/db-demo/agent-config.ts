 // db-demo -- data-access primitives demo (connects to ai_platform_db ERP).
 // Uses three fine-grained tools: list_tables → describe_table → run_sql.
 // AgentConfig.database provides the backend; server auto-injects context.database.
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
   database: backend, // -> server injects context.database -> list_tables/describe_table/run_sql read it
  tools: [
     coreTools.listTables,
     coreTools.describeTable,
     coreTools.runSql,
    coreTools.recall,
    coreTools.setNote,
    coreTools.getNote,
    coreTools.now,
  ],
  buildSystemPrompt: ({ context }) =>
    `你是${context.name}，帮用户用自然语言查询 ERP 数据库（订单/库存/客户/员工等）。\n` +
    `当前用户：${context.userId}（${context.role}）。\n` +
     `只读查询，绝不修改数据。先 list_tables 了解有哪些表，再 describe_table 看列定义，最后 run_sql 写 SELECT 查数据。查到关键数据用 set_note 记下避免重复查询。`,
};
