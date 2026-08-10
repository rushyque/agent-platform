// 数据查询能力 —— 模型直调原语。
// Codex 风格：给模型细粒度能力基元，让它自己探索表结构、写查询、看报错自纠，
// 而不是黑盒子代理替它生成 SQL。
//
// 四个原语，构成自洽的"数据库认知 → 执行"闭环：
//   list_tables    -- 有哪些表（含行数 + 业务注释）
//   describe_table -- 某张表的列定义（含业务注释）
//   sample_rows    -- 抽样几行，快速理解字段真实取值
//   run_sql        -- 执行只读 SELECT（guardSQL 强制只读）
// 数据库连接/鉴权由接入方通过 AgentConfig.database 注入后端实现（见 backend.ts）。

import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";
import type { DatabaseBackend } from "./backend.js";
import { guardSQL } from "./guard.js";

function getBackend(context: AgentContext): DatabaseBackend | undefined {
  return (context as any).database as DatabaseBackend | undefined;
}

// 1. list_tables
export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  description:
    "List all database tables with row counts and business descriptions. " +
    "Use this FIRST to understand what data is available before querying anything. " +
    "Returns table name, approximate row count, and description (if annotated).",
  parameters: z.object({}),
  readonly: true,
  execute: async (_args: any, context: AgentContext) => {
    const backend = getBackend(context);
    if (!backend) return { ok: false, error: "No database backend configured." };
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
    "Use this after list_tables to understand a table's structure before querying. " +
    "Column descriptions carry business semantics -- read them to know which columns are relevant.",
  parameters: z.object({
    tableName: z.string().describe("Table name (exact, from list_tables output)"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const backend = getBackend(context);
    if (!backend) return { ok: false, error: "No database backend configured." };
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

// 3. sample_rows
export const sampleRowsTool: ToolDefinition = {
  name: "sample_rows",
  description:
    "Sample a few rows from a table to see real values and understand column semantics. " +
    "Use after describe_table to quickly grasp how data actually looks before writing a precise run_sql query.",
  parameters: z.object({
    tableName: z.string().describe("Table name (exact, from list_tables output)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Sample row cap (default 5, max 50)."),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const backend = getBackend(context);
    if (!backend) return { ok: false, error: "No database backend configured." };
    try {
      const result = await backend.sampleRows(args.tableName, args.limit);
      return {
        ok: true,
        table: args.tableName,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rows.length,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, table: args.tableName };
    }
  },
};

// 4. run_sql -- read-only, guardSQL-enforced
export const runSqlTool: ToolDefinition = {
  name: "run_sql",
  description:
    "Execute a read-only SQL query (SELECT or WITH/CTE only). Write operations are blocked. " +
    "Use list_tables + describe_table (+ sample_rows) first to understand the schema, then write precise SQL here. " +
    "If the query errors, read the error message and fix the SQL -- you are in full control.",
  parameters: z.object({
    sql: z.string().describe("SQL read-only SELECT query (use TOP N to limit rows)"),
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
    if (!backend) return { ok: false, error: "No database backend configured." };
    const sqlText = String(args.sql || "");
    const guard = guardSQL(sqlText);
    if (!guard.ok) return { ok: false, error: guard.reason, sql: sqlText };
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
      return { ok: false, error: (e as Error).message, sql: sqlText };
    }
  },
};

// Convenience: all data-access primitives as an array
export const dataAccessTools: ToolDefinition[] = [
  listTablesTool,
  describeTableTool,
  sampleRowsTool,
  runSqlTool,
];
