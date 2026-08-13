// coreTools -- high-generalizability conversational tool primitives.
// Design philosophy: capability primitives, not business steps (Codex-aligned).
// Projects opt in explicitly via AgentConfig.tools (no global injection):
//   tools: [coreTools.runSql, coreTools.showUi, ...your business tools]

import type { ToolDefinition } from "../../types/agent-config.js";
import {
  listTablesTool,
  describeTableTool,
  sampleRowsTool,
  runSqlTool,
} from "../data/tools.js";
import { observeStateTool } from "./observe-state.js";
import { recallTool } from "./recall.js";
import { setNoteTool, getNoteTool } from "./notes.js";
import { nowTool } from "./now.js";
import { confirmTool } from "./confirm.js";
import { showUiTool, interactionTools } from "./interact.js";
import { uiClickTool, uiInteractionTools } from "./ui-click.js";
import { uiFillTool, uiFillTools } from "./ui-fill.js";
import { renderTool } from "../render/tool.js";

export const coreTools = {
  // --- data access (4 fine-grained primitives) ---
  listTables: listTablesTool, // browse tables (+ row counts + descriptions)
  describeTable: describeTableTool, // inspect a table's columns (+ descriptions)
  sampleRows: sampleRowsTool, // sample a few rows to learn real values
  runSql: runSqlTool, // execute read-only SQL (guardSQL-enforced)

  // --- state observation ---
  observeState: observeStateTool, // runtime snapshot (needs context.getState)

  // --- memory ---
  recall: recallTool, // review recent tool results
  setNote: setNoteTool, // persist a confirmed fact
  getNote: getNoteTool, // retrieve a note
  now: nowTool, // authoritative time

  // --- human-in-the-loop ---
  confirm: confirmTool, // request confirmation before a write action

  // --- front-end interaction (single tool, 3 page-level modes) ---
  showUi: showUiTool, // guide / notify / open_link

  // --- front-end triggered action (registered safe button actions) ---
  uiClick: uiClickTool, // trigger a registered page action by id (risk-gated)

  // --- front-end form fill (registered input fields) ---
  uiFill: uiFillTool, // write a value into a registered input/select/textarea by id

  // --- generic content/interaction rendering (multi-block) ---
  render: renderTool, // table / cards / chart / mermaid / document / choices / markdown / link / notify
} as const satisfies Record<string, ToolDefinition>;

// 常用能力组合 —— 中台原生提供的"开箱即用"分组。
// 项目在 AgentConfig.tools 里一行引用即可，不必各自手抄工具清单，也避免取舍不一致。

// 通用对话基元：时间 / 回看历史 / 便签记事实 / 写前确认。
// 几乎所有只读 + 人机协助型助手都需要这组（如 saleshub 当前用的正是这套）。
export const assistantPrimitives: ToolDefinition[] = [
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];

// 数据库认知查询四原语 + 结果渲染（data query → render 闭环）。
export const dataQueryPrimitives: ToolDefinition[] = [
  coreTools.listTables,
  coreTools.describeTable,
  coreTools.sampleRows,
  coreTools.runSql,
];

// 展示与页面动作组合：内容渲染（默认文本内联也为同等契约）+ 页面级引导/通知/跳转。
export const presentationPrimitives: ToolDefinition[] = [
  coreTools.render,
  coreTools.showUi,
];

export { interactionTools };
export { uiInteractionTools };
export { uiFillTools };
export { renderTool } from "../render/tool.js";
export * from "../render/index.js";

// helper (not model-direct; used inside project tools)
export { runExtract } from "./extract.js";

// optional MSSQL data backend (explicit opt-in via AgentConfig.database)
export { createMssqlBackend } from "../data/backends/mssql.js";
export type {
  DatabaseBackend,
  TableSchema,
  ColumnSchema,
  QueryResult,
} from "../data/backend.js";

// guardSQL (pure function, available for custom run_sql wrappers)
export { guardSQL } from "../data/guard.js";

// data-access primitive set as a convenience array
export { dataAccessTools } from "../data/tools.js";
