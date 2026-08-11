import { test } from "node:test";
import assert from "node:assert/strict";
import { stageToolResult } from "./artifact-store.js";

// stageToolResult 的分级契约：预算内结果完整内联（inline=true, ref=null），
// 摘要倾向业务字段（trace/message/summary/error/detail/data）。外置分支会触碰
// Prisma（联网），不在单测里覆盖，交给开发环境实测验证。

test("stageToolResult: 预算内结果直接内联，不产生 ref", async () => {
  const result = {
    count: 3,
    orders: [
      { orderNo: "A1", amount: 100 },
      { orderNo: "A2", amount: 200 },
    ],
  };
  const staged = await stageToolResult(result, {
    maxInlineChars: 10_000,
    toolName: "list_orders",
  });
  assert.equal(staged.inline, true);
  assert.equal(staged.ref, null);
  assert.ok(staged.summary.length > 0);
});

test("stageToolResult: 摘要优先取业务字段而非整个对象的序列化", async () => {
  const result = {
    summary: "共 3 笔，已收 300",
    orders: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
  const staged = await stageToolResult(result, {
    maxInlineChars: 10_000,
    toolName: "order_stats",
  });
  assert.equal(staged.inline, true);
  assert.match(staged.summary, /3 笔/);
  assert.ok(!staged.summary.includes('"orders"'));
});

test("stageToolResult: 串行化长度决定是否内联（阈值判定在序列化长度上）", async () => {
  const small = { n: 1 };
  // maxInlineChars 恰好能容纳 small 的序列化 → 仍判内联
  const staged = await stageToolResult(small, {
    maxInlineChars: JSON.stringify(small).length,
    toolName: "x",
  });
  assert.equal(staged.inline, true);
});
