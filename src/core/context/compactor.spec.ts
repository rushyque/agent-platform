import { test } from "node:test";
import assert from "node:assert/strict";
import { compactPrompt } from "./compactor.js";
import { DEFAULT_POLICY } from "./policy.js";

// 阶段3防循环闭闸：外置信封（{ref,toolName,summary,full:false}）不得被折叠，
// 否则唯一可续取的 ref 被摘掉，模型"看不到又取不回"必然重查。

function makePrompt(parts: { toolName: string; output: unknown }[], hot = 0) {
  // hotToolResults=0 → 所有非豁免 tool-result 都进折叠候选
  const policy = { ...DEFAULT_POLICY, hotToolResults: hot, maxPromptChars: 1 };
  const entries: any[] = [];
  parts.forEach((p, i) => {
    entries.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: p.toolName, input: {} }],
    });
    entries.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${i}`,
          toolName: p.toolName,
          output: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
        },
      ],
    });
  });
  return { policy, entries };
}

test("外置信封（ref+full:false）不折叠，ref 完整保留", async () => {
  const envelope = {
    ref: "art-abc123",
    toolName: "saleshub_list_remittances",
    summary: "共344笔",
    full: false,
  };
  const { policy, entries } = makePrompt([
    { toolName: "saleshub_list_remittances", output: envelope },
  ]);
  const out = await compactPrompt(entries, policy);
  const part = out[1].content[0];
  assert.equal(part.type, "tool-result");
  const parsed = JSON.parse(part.output);
  assert.equal(parsed.ref, "art-abc123");
  assert.equal(parsed.full, false);
});

test("普通内联大结果仍正常折叠（豁免只针对外置信封）", async () => {
  const big = { rows: Array.from({ length: 100 }, (_, i) => ({ id: i, v: "x".repeat(50) })) };
  const { policy, entries } = makePrompt([
    { toolName: "saleshub_mutating_tool", output: big },
  ]);
  const out = await compactPrompt(entries, policy);
  const text = out[1].content[0].output;
  assert.ok(typeof text === "string" && text.includes("已折叠"), "应被折叠为占位");
});

test("readonly 声明的工具结果不折叠（既有行为不受影响）", async () => {
  const big = { rows: Array.from({ length: 100 }, (_, i) => ({ id: i, v: "x".repeat(50) })) };
  const { policy, entries } = makePrompt([
    { toolName: "saleshub_list_remittances", output: big },
  ]);
  const out = await compactPrompt(entries, policy, new Set(["saleshub_list_remittances"]));
  const text = out[1].content[0].output;
  assert.ok(!String(text).includes("已折叠"), "readonly 结果不应被折叠");
});
