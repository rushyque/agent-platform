 // db-demo -- 数据查询能力示例（可选复用 createMssqlBackend 连业务库）。
 // 使用四个细粒度原语：list_tables → describe_table → sample_rows → run_sql。
 // AgentConfig.database 显式注入后端；server 自动注入 context.database。
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
    coreTools.sampleRows,
    coreTools.runSql,
    coreTools.recall,
    coreTools.setNote,
    coreTools.getNote,
    coreTools.now,
    coreTools.render,
  ],
  buildSystemPrompt: ({ context }) =>
    `你是${context.name}，帮用户用自然语言查询 ERP 数据库（订单/库存/客户/员工等）。\n` +
    `当前用户：${context.userId}（${context.role}）。\n` +
     `只读查询，绝不修改数据。先 list_tables 了解有哪些表，再 describe_table 看列定义，需要时可 sample_rows 看真实取值，最后 run_sql 写 SELECT 查数据。查到关键数据用 set_note 记下避免重复查询。\n` +
     `要把结果呈现给用户时，用 render 工具结构化为渲染块（cards 总览 + table 明细，需要时加 chart/mermaid），不要只丢一段裸文本。`,
};
