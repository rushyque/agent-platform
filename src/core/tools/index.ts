// coreTools -- high-generalizability conversational tool primitives.
// Design philosophy: capability primitives, not business steps (Codex-aligned).
// Projects opt in explicitly via AgentConfig.tools (no global injection):
//   tools: [coreTools.runSql, coreTools.showUi, ...your business tools]

import type { ToolDefinition } from "../../types/agent-config.js";
import { listTablesTool, describeTableTool, runSqlTool } from "./query-database/index.js";
import { observeStateTool } from "./observe-state.js";
import { recallTool } from "./recall.js";
import { setNoteTool, getNoteTool } from "./notes.js";
import { nowTool } from "./now.js";
import { confirmTool } from "./confirm.js";
import { showUiTool, interactionTools } from "./interact.js";

export const coreTools = {
  // --- data access (3 fine-grained primitives, replace old query_database) ---
  listTables: listTablesTool, // browse tables (+ row counts + descriptions)
  describeTable: describeTableTool, // inspect a table's columns (+ descriptions)
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

  // --- front-end interaction (single tool, 4 modes) ---
  showUi: showUiTool, // guide / choices / notify / open_link
} as const satisfies Record<string, ToolDefinition>;

export { interactionTools };

// helper (not model-direct; used inside project tools)
export { runExtract } from "./extract.js";

// default DB adapter (out of the box, connects to persistence/db.ts pool)
export { createMssqlBackend } from "./backends/mssql.js";
export type { DatabaseBackend, TableSchema, ColumnSchema, QueryResult } from "./query-database/backend.js";

// guardSQL (pure function, available for custom run_sql wrappers)
export { guardSQL } from "./query-database/guard.js";

// data-access primitive set as a convenience array
export { dataAccessTools } from "./query-database/index.js";
