import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseBackend } from "./backend.js";
import {
  listTablesTool,
  describeTableTool,
  sampleRowsTool,
  runSqlTool,
  dataAccessTools,
} from "./tools.js";

function makeBackend(partial: Partial<DatabaseBackend> = {}): DatabaseBackend {
  return {
    listTables: async () => [
      { name: "sh_orders", columns: [], rowCount: 100, description: "订单" },
    ],
    describeTable: async (name) => ({
      name,
      columns: [{ name: "id", dataType: "int", nullable: false }],
      description: "订单表",
    }),
    sampleRows: async (name) => ({
      columns: ["id"],
      rows: [[1]],
    }),
    executeQuery: async (sql) => ({
      columns: ["company"],
      rows: [["A公司"]],
    }),
    ...partial,
  };
}

test("dataAccessTools 恰好包含四个原语", () => {
  assert.deepEqual(
    dataAccessTools.map((t) => t.name),
    ["list_tables", "describe_table", "sample_rows", "run_sql"]
  );
});

test("list_tables 返回表概览；无后端时报错", async () => {
  const r = await listTablesTool.execute({}, { database: makeBackend() });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.tables[0].name, "sh_orders");

  const noBackend = await listTablesTool.execute({}, {});
  assert.equal(noBackend.ok, false);
  assert.match(noBackend.error, /No database backend/i);
});

test("describe_table 调用后端并输出列定义", async () => {
  const r = await describeTableTool.execute(
    { tableName: "sh_orders" },
    { database: makeBackend() }
  );
  assert.equal(r.ok, true);
  assert.equal(r.table, "sh_orders");
  assert.equal(r.columns[0].name, "id");
});

test("sample_rows 透传 limit；后端抛错时返回 ok:false", async () => {
  const ok = await sampleRowsTool.execute(
    { tableName: "t", limit: 3 },
    { database: makeBackend() }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.rowCount, 1);

  const err = await sampleRowsTool.execute(
    { tableName: "t" },
    {
      database: makeBackend({
        sampleRows: async () => {
          throw new Error("boom");
        },
      }),
    }
  );
  assert.equal(err.ok, false);
  assert.equal(err.error, "boom");
});

test("run_sql 拒绝写操作（不改后端即报错）", async () => {
  const r = await runSqlTool.execute(
    { sql: "DELETE FROM t" },
    { database: makeBackend() }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /写\/破坏操作/);
});

test("run_sql 执行合法 SELECT 返回行列；后端抛错时 ok:false", async () => {
  const ok = await runSqlTool.execute(
    { sql: "SELECT company FROM t", limit: 10 },
    { database: makeBackend() }
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.columns, ["company"]);

  const err = await runSqlTool.execute(
    { sql: "SELECT * FROM missing" },
    {
      database: makeBackend({
        executeQuery: async () => {
          throw new Error("Invalid object name");
        },
      }),
    }
  );
  assert.equal(err.ok, false);
  assert.equal(err.error, "Invalid object name");
});
