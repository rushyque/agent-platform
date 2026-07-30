// 中台通用工具层（coreTools）—— 高通用度、有设计难点的对话工具集合。
// 设计理念见 .claude/plans/中台通用工具层.md：能力原语 / 探索与行动分层 / 结构化事实返回。
//
// 项目在 AgentConfig.tools 里【显式取用】（不全局注入）：
//   tools: [coreTools.queryDatabase, coreTools.observeState, ...自己的业务工具]
// 挂哪个来哪个；不需要的能力（如游戏不查库）就不挂，避免污染模型工具空间、
// 也避免工具过多导致 DeepSeek 乱选（工具选择能力一般，见记忆 context-management）。

import type { ToolDefinition } from "../../types/agent-config.js";
import { queryDatabaseTool } from "./query-database/index.js";
import { observeStateTool } from "./observe-state.js";
import { recallTool } from "./recall.js";
import { setNoteTool, getNoteTool } from "./notes.js";
import { nowTool } from "./now.js";
import { confirmTool } from "./confirm.js";

export const coreTools = {
  // 感知
  queryDatabase: queryDatabaseTool, // NL→SQL 只读查询（需 context.database）
  observeState: observeStateTool, // 运行态快照（需 context.getState）
  recall: recallTool, // 回看历史工具结果
  // 记忆
  setNote: setNoteTool, // 记已确认事实
  getNote: getNoteTool, // 取便签
  now: nowTool, // 权威时间
  // 人机
  confirm: confirmTool, // 写操作前人确认（异步简版）
} as const satisfies Record<string, ToolDefinition>;

// helper（非模型直调，项目工具内部用）
export { runExtract } from "./extract.js";

// 默认 DB 适配器（开箱即用，连 persistence/db.ts 的连接池）
export { createMssqlBackend } from "./backends/mssql.js";
export type { DatabaseBackend, TableSchema, ColumnSchema, QueryResult } from "./query-database/backend.js";
