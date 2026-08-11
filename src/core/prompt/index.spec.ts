import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composePrompt,
  section,
  agentProtocol,
  outputProtocol,
  terminationProtocol,
} from "./index.js";

test("composePrompt 合并多个非空片段，剔除空/假值", () => {
  const out = composePrompt(["A", undefined, "B", false, "", null, "C"]);
  assert.equal(out, "A\n\nB\n\nC");
});

test("composePrompt 全部为空时返回空字符串", () => {
  assert.equal(composePrompt([undefined, "", false]), "");
});

test("section 生成 `# 标题` + 正文", () => {
  const out = section("角色", "你是助手");
  assert.equal(out, "# 角色\n你是助手");
});

test("agentProtocol 组装角色/能力/边界", () => {
  const out = agentProtocol({
    persona: "你是销售助手",
    capabilities: ["查订单", "查客户"],
    boundaries: ["只读"],
  });
  assert.match(out, /^# 角色与边界/);
  assert.match(out, /你能做/);
  assert.match(out, /查订单/);
  assert.match(out, /边界/);
  assert.match(out, /只读/);
});

test("outputProtocol 默认包含中文与 render 说明", () => {
  const out = outputProtocol();
  assert.match(out, /# 输出约定/);
  assert.match(out, /用中文/);
  assert.match(out, /<render>/);
});

test("terminationProtocol 强调防空转与收束", () => {
  const out = terminationProtocol();
  assert.match(out, /# 收束与防空转/);
  assert.match(out, /反复重查/);
});
