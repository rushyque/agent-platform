import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../../types/agent-config.js";
import type { DatabaseBackend } from "./backend.js";
import { guardSQL } from "./guard.js";

// Data-access primitives (Codex philosophy: give the model fine-grained tools,
// let it explore and compose freely instead of a black-box sub-agent).
//
// Three tools replace the old query_database NL2SQL sub-agent:
//   list_tables    -- "what tables exist?" (with row counts + descriptions)
//   describe_table -- "what columns does table X have?" (with descriptions)
//   run_sql        -- "run this SELECT" (guardSQL-enforced read-only)
//
// The model drives the exploration loop itself: browse tables, pick relevant ones,
// write SQL, see errors, fix and retry. Semantic annotations (MS_Description) flow
// through from the backend so the model gets business-level column literacy.

function getBackend(context: AgentContext): DatabaseBackend | undefined {
  return (context as any).database as DatabaseBackend | undefined;
}

// 1. list_tables
export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  description:
    "List all database tables with row counts and business descriptions. " +
    "Use this FIRST to understand what data is available before writing any SQL. " +
    "Returns table name, approximate row count, and description (if annotated).",
  parameters: z.object({}),
  readonly: true,
  execute: async (_args: any, context: AgentContext) => {
    const backend = getBackend(context);
    if (!backend) {
      return { ok: false, error: "No database backend configured." };
    }
    const tables = await backend.listTables();
    return {
      ok: true,
      count: tables.length,
      tables: tables.map((t) => ({
        name: t.name,
        rows: t.rowCount,
        description: t.description,
      })),
    };
  },
};

// 2. describe_table
export const describeTableTool: ToolDefinition = {
  name: "describe_table",
  description:
    "Show column definitions for a specific table (name, type, nullable, business description). " +
    "Use this after list_tables to understand a table's structure before writing SQL. " +
    "Column descriptions carry business semantics -- read them to know which columns are relevant.",
  parameters: z.object({
    tableName: z.string().describe("Table name (exact, from list_tables output)"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const backend = getBackend(context);
    if (!backend) {
      return { ok: false, error: "No database backend configured." };
    }
    const schema = await backend.describeTable(args.tableName);
    return {
      ok: true,
      table: schema.name,
      description: schema.description,
      columns: schema.columns.map((c) => ({
        name: c.name,
        type: c.dataType,
        nullable: c.nullable,
        description: c.description,
      })),
    };
  },
};

// 3. run_sql -- read-only, guardSQL-enforced
export const runSqlTool: ToolDefinition = {
  name: "run_sql",
  description:
    "Execute a read-only SQL query (SELECT or WITH/CTE only). Write operations are blocked. " +
    "Use list_tables + describe_table first to understand the schema, then write precise SQL here. " +
    "If the query errors, read the error message and fix the SQL -- you are in full control.",
  parameters: z.object({
    sql: z.string().describe("MSSQL read-only SELECT query (use TOP N to limit rows)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Row cap (default 50, max 500). Applied even if you forget TOP."),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const backend = getBackend(context);
    if (!backend) {
      return { ok: false, error: "No database backend configured." };
    }
    const sqlText = String(args.sql || "");
    // Safety gate: reject anything that isn't a read-only SELECT/WITH
    const guard = guardSQL(sqlText);
    if (!guard.ok) {
      return { ok: false, error: guard.reason, sql: sqlText };
    }
    try {
      const result = await backend.executeQuery(sqlText, args.limit);
      return {
        ok: true,
        columns: result.columns,
        rows: result.rows,
        truncated: result.truncated,
        rowCount: result.rows.length,
      };
    } catch (e) {
 // Surface the raw DB error so the model can self-correct
      return { ok: false, error: (e as Error).message, sql: sqlText };
    }
  },
};

// Convenience: all three primitives as an array
export const dataAccessTools: ToolDefinition[] = [listTablesTool, describeTableTool, runSqlTool];
