import type { AgentConfig, AgentContext } from "../types/agent-config.js";

// AgentConfig 注册中心 —— 项目通过 registerAgent 注册，平台通过 resolveAgent 获取
const registry = new Map<string, AgentConfig>();

export function registerAgent(config: AgentConfig): void {
  registry.set(config.agentId, config);
}

export function resolveAgent(agentId: string): AgentConfig | undefined {
  return registry.get(agentId);
}

export function getAllAgentIds(): string[] {
  return Array.from(registry.keys());
}
