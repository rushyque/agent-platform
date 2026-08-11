import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlocks } from "./contract.js";

test("validateBlocks: 接受合法的 table 块", () => {
  const blocks = validateBlocks([
    {
      kind: "table",
      columns: [{ key: "id", label: "ID" }],
      rows: [{ id: 1 }],
    },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "table");
});

test("validateBlocks: 非数组 / 空 / 超 16 个被拒绝", () => {
  assert.throws(() => validateBlocks(null), /必须是一个数组/);
  assert.throws(() => validateBlocks([]), /不能为空/);
  const many = Array.from({ length: 17 }, (_, i) => ({
    kind: "markdown",
    markdown: `m${i}`,
  }));
  assert.throws(() => validateBlocks(many), /最多 16 个/);
});

test("validateBlocks: 非法块给出索引化错误", () => {
  assert.throws(
    () => validateBlocks([{ kind: "not-a-kind", x: 1 }]),
    /blocks\[0\] 不合法/
  );
});

test("validateBlocks: 拒绝缺失必填字段", () => {
  assert.throws(
    () => validateBlocks([{ kind: "link", url: "https://x" }]),
    /label/
  );
});

test("validateBlocks: choices 接受 header 与 recommended 字段", () => {
  const [b] = validateBlocks([
    {
      kind: "choices",
      header: "查询口径",
      prompt: "想按哪个口径查询？",
      choices: [
        { label: "按工单日期", value: "工单日期", recommended: true, description: "默认" },
        { label: "按状态变更", value: "状态变更" },
      ],
    },
  ]);
  assert.equal(b.kind, "choices");
  assert.equal(b.header, "查询口径");
  assert.equal(b.choices[0].recommended, true);
});
