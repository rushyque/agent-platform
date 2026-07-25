import { z } from "zod";
import type { Message } from "@ag-ui/core";
import type { LanguageModel } from "ai";

// 平台上下文 —— 项目适配层返回的任意结构
export type AgentContext = Record<string, any>;

// 工具定义
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: any, context: AgentContext) => Promise<any>;
}

// AgentConfig —— 每个接入系统的配置契约
export interface AgentConfig {
  agentId: string;
  description?: string;

  // 从请求中解析业务上下文（平台调，项目实现）
  resolveContext: (request: {
    userId: string;
    token: string;
    headers: Record<string, string>;
  }) => Promise<AgentContext>;

  // 项目暴露的工具集
  tools: ToolDefinition[];

  // 动态构建 system prompt（平台调，项目实现）
  // intent 由平台层（Prompt Engine）一次性计算后透传，避免重复分类
  buildSystemPrompt: (params: {
    context: AgentContext;
    messages: Message[];
    intent?: string;
  }) => string;

  // 可选：项目自带的意图分类（平台不内置业务关键词）。
  // 平台在 Hermes 模式每轮调用一次，结果透传给 selectTools 与 buildSystemPrompt。
  // 缺省返回 "general"；项目需要聚焦工具子集时自行实现此钩子 + selectTools。
  classifyIntent?: (params: {
    messages: Message[];
    context: AgentContext;
  }) => string;

  // 可选：按意图选择工具子集（缺省暴露全部工具）
  selectTools?: (params: {
    intent: string;
    allTools: ToolDefinition[];
    context: AgentContext;
  }) => ToolDefinition[];

  // 可选：复杂场景的 DAG 定义（存在则该 agent 走 Harness / DAGAgent）
  dagDefinition?: DAGDefinition;

  // 可选：指定模型名（Hermes 模式）
  model?: string;

  // 可选：自定义创建 LLM model 实例（DAG 模式优先使用；缺省走平台 DeepSeek model）
  createModel?: () => LanguageModel;
}

// DAG 步骤定义（Harness 模式）
export interface DAGDefinition {
  steps: DAGStep[];
}

export interface DAGStep {
  id: string;
  type: "llm" | "tool" | "condition" | "transform";
  name: string;
  // tool 步骤：要调用的工具名（对应 tools 集合里的 name）
  toolName?: string;
  // tool 步骤：从 state 中取参数的取值器（缺省则传空对象）
  toolArgs?: (state: Record<string, any>) => Record<string, any>;
  // llm 步骤：system prompt，可用 ${state.xxx} 占位符注入上游结果
  prompt?: string;
  // llm 步骤：结果写入 state 的 key
  outputKey?: string;
  // condition 步骤：返回下一个 stepId
  condition?: (state: Record<string, any>) => string;
  // transform 步骤：直接变换 state
  transform?: (state: Record<string, any>) => Record<string, any>;
  // 下一步：stepId 或基于 state 计算的 stepId（终点用 "__end__"）
  next: string | ((state: Record<string, any>) => string);
}

// 工具调用权限错误的结构化响应
export interface PermissionDeniedResult {
  status: "permission_denied";
  message: string;
  suggestion: string;
}

// 平台级 trace —— 所有"内部多步工具"统一此格式，给主模型适度透明度：
// 让主模型知道做了什么、拿到什么、改了什么，但不暴露原始 IO（避免上下文爆炸）。
// 设计依据见记忆 nl2sql-design：成功极简（一条）、自纠成功带修正 diff、彻底失败带全部轮次。
export interface TraceRound {
  // 本轮关键产物（NL→SQL 里是生成的 SQL）。失败/被拦截的轮次也记录，看到全过程
  artifact: string;
  // 本轮结果：success 成功 / rejected 前置校验拒绝 / exec_error 执行报错 /
  // gen_error 生成报错 / no_data 无数据
  outcome: "success" | "rejected" | "exec_error" | "gen_error" | "no_data";
  // 修正说明：基于本轮错误给下一轮的反馈——自纠场景最有价值的信息；终轮无此字段
  fix?: string;
}

export interface ToolTrace {
  tool: string; // 工具名，多工具统一格式时区分来源
  rounds: TraceRound[];
  schemaUsed?: boolean; // 是否拿到可用 schema（false=降级盲查，准确率会降）
  schemaWarnings?: string[];
}
