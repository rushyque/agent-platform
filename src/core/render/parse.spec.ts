import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRenderBlocks,
  renderBlocksToText,
} from "./parse.js";

test("parseRenderBlocks: 从 <render>{json}</render> 解析单块", () => {
  const blocks = parseRenderBlocks(
    '结果如下<render>{"kind":"table","columns":[{"key":"id","label":"ID"}],"rows":[{"id":1}]}</render>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "table");
});

test("parseRenderBlocks: 从 <render>[数组]</render> 解析多块并去重", () => {
  const block = '{"kind":"markdown","markdown":"hi"}';
  // 同一数组重复出现两次，应只保留一次
  const blocks = parseRenderBlocks(`<render>[${block},${block}]</render>`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "markdown");
});

test("parseRenderBlocks: 支持围栏与 RENDER_BLOCKS= 写法", () => {
  const fenced = parseRenderBlocks(
    '```render+json\n[{"kind":"cards","cards":[{"title":"本月","value":100}]}]\n```'
  );
  assert.equal(fenced[0].kind, "cards");

  const assigned = parseRenderBlocks(
    'RENDER_BLOCKS= {"blocks":[{"kind":"choices","choices":[{"label":"是","value":"yes"}]}]}'
  );
  assert.equal(assigned[0].kind, "choices");
});

test("parseRenderBlocks: 空或非字符串输入返回空数组", () => {
  assert.deepEqual(parseRenderBlocks("普通文本"), []);
  assert.deepEqual(parseRenderBlocks(""), []);
  assert.deepEqual(parseRenderBlocks(null), []);
});

test("renderBlocksToText: 序列化为 <render> 并回读一致", () => {
  const blocks = [
    {
      kind: "mermaid" as const,
      code: "graph TD; A-->B",
    },
  ];
  const text = renderBlocksToText(blocks);
  assert.match(text, /^<render>\[/);
  const parsed = parseRenderBlocks(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "mermaid");
});
