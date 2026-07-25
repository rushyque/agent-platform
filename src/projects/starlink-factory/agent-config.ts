// 星联模具工厂 —— AgentConfig（项目接入契约）。
// 平台通过 src/projects/index.ts 注册本项目，零核心改动即可驱动。
import type { AgentConfig } from "../../types/agent-config.js";
import { factoryTools } from "./tools/index.js";
import { buildFactoryPrompt } from "./prompts.js";

export const starlinkFactoryAgentConfig: AgentConfig = {
  agentId: "starlink_factory",
  description: "星联精密模具工厂运营模拟（PET 吹瓶模/注坯模/瓶盖模）。模型扮演生产调度经理，通过工具接单/设计/排产/加工/试模/交付，运营整座工厂。",
  // mock 鉴权：从平台解析的 userId 直接作为厂长身份，固定 manager 角色。
  // 真实 SSO/对接留待后续（本轮只验证"中台驱动工厂"）。
  resolveContext: async ({ userId }) => ({
    userId,
    role: "factory_manager",
    name: "生产调度经理",
    factoryName: "星联精密 · PET吹瓶模智能工厂（佛山）",
  }),
  tools: factoryTools,
  buildSystemPrompt: ({ context }) => buildFactoryPrompt(context),
};
