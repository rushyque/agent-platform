import { generateObject } from "ai";
import { z } from "zod";
import { createLLMClient } from "../../llm.js";
import type {
  DatabaseBackend,
  TableSchema,
  ColumnSchema,
  QueryResult,
} from "./backend.js";
import { guardSQL } from "./guard.js";
import type { ToolTrace, TraceRound } from "../../../types/agent-config.js";

// NL→SQL 子 agent —— 模仿 Claude 查库的纪律：
//   阶段0 拉表概览（表名+行数，不拉列，省 token）
//   阶段1 LLM 选相关表（避免 48 张表全 schema 灌爆 generateObject）
//   阶段2 拉选中表列定义
//   阶段3 生成 SQL → guardSQL → 执行 → 失败自纠（≤3 轮）
// trace 透传给主模型：知道做了什么/拿到什么，不看原始 IO（设计依据见记忆 nl2sql-design）。

const MAX_ROUNDS = 3;
const TOOL_NAME = "query_database";

export interface NL2SQLOptions {
  question: string;
  backend: DatabaseBackend;
  limit?: number;
  model?: string;
}

export interface NL2SQLResult {
  ok: boolean;
  sql?: string;
  rows?: QueryResult;
  explanation?: string;
  trace: ToolTrace;
  schemaWarnings?: string[];
  error?: string;
}

function renderColumn(c: ColumnSchema): string {
  return `${c.name} ${c.dataType}${c.nullable ? "" : " NOT NULL"}${c.description ? ` -- ${c.description}` : ""}`;
}

function renderTableSchema(t: TableSchema): string {
  const cols = (t.columns ?? []).map(renderColumn).join(",\n  ");
  const head = `表 ${t.name}${t.rowCount != null ? ` (~${t.rowCount} 行)` : ""}${t.description ? ` -- ${t.description}` : ""}`;
  return `${head}\n  ${cols}`;
}

function selectTablesPrompt(
  question: string,
  tables: Array<{ name: string; rowCount?: number; description?: string }>
): string {
  const list = tables
    .map((t) => `- ${t.name}${t.rowCount != null ? ` (~${t.rowCount}行)` : ""}`)
    .join("\n");
  return [
    "你是数据库导航员。给定一个自然语言问题和数据库所有表，选出回答该问题【最相关】的 1-5 张表。",
    "只选真正需要的表，宁少勿多（列定义会按你选的表拉取）。",
    "必须从给定表名列表里选，原样返回表名（含大小写）。",
    "",
    `问题：${question}`,
    "",
    "数据库表：",
    list,
  ].join("\n");
}

function generateSQLPrompt(
  question: string,
  schemaText: string,
  limit: number,
  prevError?: string
): string {
  const parts = [
    "你是 MSSQL(SQL Server) SQL 专家。根据以下表结构，为用户的自然语言问题写一条【只读】查询 SQL。",
    "规则：",
    "1. 只能用 SELECT 或 WITH(CTE)，禁止任何写操作(INSERT/UPDATE/DELETE/DROP...)。",
    `2. 必须用 TOP ${limit} 限制返回行数（写在最外层 SELECT 后），避免全表扫描。`,
    "3. 严格基于给定列名，不要臆造列；聚合优先(GROUP BY/SUM/COUNT)，不要拉全表再算。",
    "4. 日期/枚举字段若不确定取值，用合理过滤或先不硬编码。",
    "5. nvarchar 字段可能存中文，比较时注意。",
    "",
    `问题：${question}`,
    "",
    "相关表结构：",
    schemaText,
  ];
  if (prevError) {
    parts.push("", `上一轮出错，请修正：${prevError}`, "（修正后重新给出完整 SQL）");
  }
  return parts.join("\n");
}

export async function runNL2SQLAgent(opts: NL2SQLOptions): Promise<NL2SQLResult> {
  const { question, backend, model } = opts;
  const limit = opts.limit ?? 50;
  const rounds: TraceRound[] = [];
  const schemaWarnings: string[] = [];

  // 阶段 0：表概览
  let tablesOverview: Array<{ name: string; rowCount?: number; description?: string }> = [];
  try {
    tablesOverview = (await backend.listTables()).map((t) => ({
      name: t.name,
      rowCount: t.rowCount,
      description: t.description,
    }));
  } catch (e) {
    schemaWarnings.push(`listTables 失败: ${(e as Error).message}`);
  }
  if (tablesOverview.length === 0) {
    return {
      ok: false,
      error: "无法获取数据库表结构",
      trace: { tool: TOOL_NAME, rounds, schemaUsed: false, schemaWarnings },
    };
  }

  // 阶段 1：选表
  let targetTables: string[] = [];
  try {
    const { object } = await generateObject({
      model: createLLMClient(model),
      schema: z.object({
        tables: z.array(z.string()).min(1).max(8).describe("相关表名，必须来自给定列表"),
      }),
      prompt: selectTablesPrompt(question, tablesOverview),
    });
    const valid = new Set(tablesOverview.map((t) => t.name));
    targetTables = object.tables.filter((t) => valid.has(t));
    if (targetTables.length === 0) schemaWarnings.push("选表未命中列表，回退全表前20");
    rounds.push({ artifact: `选表: ${object.tables.join(", ")}`, outcome: "success" });
  } catch (e) {
    schemaWarnings.push(`选表生成失败: ${(e as Error).message}`);
    rounds.push({ artifact: "选表(失败)", outcome: "gen_error" });
  }
  if (targetTables.length === 0) {
    targetTables = tablesOverview.slice(0, 20).map((t) => t.name);
  }

  // 阶段 2：拉选中表列定义
  const schemaParts: string[] = [];
  for (const tname of targetTables) {
    try {
      schemaParts.push(renderTableSchema(await backend.describeTable(tname)));
    } catch (e) {
      schemaWarnings.push(`describeTable ${tname} 失败: ${(e as Error).message}`);
    }
  }
  const schemaUsed = schemaParts.length > 0;
  const schemaText = schemaParts.join("\n\n");

  // 阶段 3：生成 + guard + 执行 + 自纠
  let prevError = "";
  let lastSql = "";
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const fixFromPrev = prevError || undefined; // 本轮要修正的上一轮错误（第1轮为空）

    let sql = "";
    let explanation = "";
    try {
      const { object } = await generateObject({
        model: createLLMClient(model),
        schema: z.object({
          sql: z.string().describe(`MSSQL 只读 SELECT，含 TOP ${limit}`),
          explanation: z.string().describe("一句话解释这条查询"),
        }),
        prompt: generateSQLPrompt(question, schemaText, limit, fixFromPrev),
      });
      sql = object.sql.trim();
      explanation = object.explanation;
      lastSql = sql;
    } catch (e) {
      rounds.push({
        artifact: "(生成失败)",
        outcome: "gen_error",
        ...(fixFromPrev ? { fix: fixFromPrev } : {}),
      });
      return {
        ok: false,
        error: `SQL 生成失败: ${(e as Error).message}`,
        trace: { tool: TOOL_NAME, rounds, schemaUsed, schemaWarnings },
      };
    }

    // guard
    const g = guardSQL(sql);
    if (!g.ok) {
      prevError = `安全校验拒绝: ${g.reason}`;
      rounds.push({
        artifact: sql,
        outcome: "rejected",
        ...(fixFromPrev ? { fix: fixFromPrev } : {}),
      });
      continue;
    }

    // 执行
    try {
      const result = await backend.executeQuery(sql, limit);
      const noData = result.rows.length === 0;
      rounds.push({
        artifact: sql,
        outcome: noData ? "no_data" : "success",
        ...(fixFromPrev ? { fix: fixFromPrev } : {}),
      });
      return {
        ok: true,
        sql,
        rows: result,
        explanation,
        trace: { tool: TOOL_NAME, rounds, schemaUsed, schemaWarnings },
      };
    } catch (e) {
      prevError = `执行错误: ${(e as Error).message}`;
      rounds.push({
        artifact: sql,
        outcome: "exec_error",
        ...(fixFromPrev ? { fix: fixFromPrev } : {}),
      });
      continue;
    }
  }

  // 循环结束仍未成功：终轮不留 fix（无下一轮可反馈）
  if (rounds.length > 0) {
    delete (rounds[rounds.length - 1] as any).fix;
  }
  return {
    ok: false,
    sql: lastSql || undefined,
    error: `${MAX_ROUNDS} 轮自纠后仍失败${prevError ? `：${prevError}` : ""}`,
    trace: { tool: TOOL_NAME, rounds, schemaUsed, schemaWarnings },
  };
}
