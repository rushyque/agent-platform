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
