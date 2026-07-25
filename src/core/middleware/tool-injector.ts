import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";

// 工具注入器 —— 平台默认暴露全部工具；项目可在 AgentConfig.selectTools 中覆盖（自行聚焦/裁剪）。
// 平台不内置任何"业务意图→工具"映射：那是项目语义，不是平台职责。
export function selectToolsForRun(params: {
  intent: string;
  allTools: ToolDefinition[];
  context: AgentContext;
  override?: (p: {
    intent: string;
    allTools: ToolDefinition[];
    context: AgentContext;
  }) => ToolDefinition[];
}): ToolDefinition[] {
  const { intent, allTools, context, override } = params;
  if (override) return override({ intent, allTools, context });
  return allTools;
}
