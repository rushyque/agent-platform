import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSQL } from "./guard.js";

test("guardSQL: 允许只读 SELECT", () => {
  assert.equal(guardSQL("SELECT * FROM sh_orders").ok, true);
  assert.equal(guardSQL("select top 20 company, amount from sh_receipts").ok, true);
});

test("guardSQL: 允许 WITH/CTE 只读查询", () => {
  const sql =
    "WITH t AS (SELECT id FROM sh_orders) SELECT * FROM t WHERE id > 1";
  assert.equal(guardSQL(sql).ok, true);
});

test("guardSQL: 拒绝写/破坏操作", () => {
  const cases = [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
    "ALTER TABLE t ADD c int",
    "CREATE TABLE t (id int)",
    "GRANT SELECT TO x",
    "REVOKE SELECT FROM x",
    "MERGE INTO t USING s ON ...",
    "EXEC sp_who",
    "exec xp_cmdshell 'dir'",
  ];
  for (const sql of cases) {
    const r = guardSQL(sql);
    assert.equal(r.ok, false, `应为拒绝: ${sql}`);
    assert.ok(r.reason && r.reason.length > 0);
  }
});

test("guardSQL: 注释被剥离，注释内的写关键字不会误伤只读查询", () => {
  // 注释内容被剥离，SELECT 中夹带注释属合法
  assert.equal(guardSQL("SELECT 1 /* note about UPDATE */").ok, true);
  assert.equal(
    guardSQL("SELECT 1 FROM t WHERE 1=1; -- DELETE FROM t").ok,
    true
  );
});

test("guardSQL: 注释拆分不能绕过真实写操作", () => {
  // 真实 UPDATE ... SET 即使夹注释仍被捕获
  assert.equal(guardSQL("UPDATE /* c */ t SET a = 1").ok, false);
  assert.equal(guardSQL("SELECT 1; -- DROP TABLE t").ok, true);
});

test("guardSQL: 非 SELECT/WITH 开头被拒绝", () => {
  assert.equal(guardSQL("SELECTOR 1").ok, false);
  assert.equal(guardSQL("withdraw FROM t").ok, false);
  assert.equal(guardSQL("").ok, false);
  assert.equal(guardSQL(null as unknown as string).ok, false);
});
