import { z } from "zod";
import type { Message } from "@ag-ui/core";
import type { LanguageModel } from "ai";
import type { DatabaseBackend } from "../core/data/backend.js";
import type { LoopGuardOptions } from "../core/middleware/loop-guard.js";

// 平台上下文 —— 项目适配层返回的开放结构。
// 这是"项目自定义上下文"的契约边界：中台 core 不假定其形状，项目在
// resolveContext 里自行注入 userId / role / token / 钩子等任意字段。
// 建议项目用 `interface XxxContext extends AgentContext { ... }` 获得类型，
// 而不是在这里为所有字段建索引（那会收紧而非放开扩展性）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentContext = Record<string, any>;

// 工具定义
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: any, context: AgentContext) => Promise<any>;
  // 可选：声明只读工具。只读工具的结果不进入上下文折叠候选（始终完整保留），
  // 断"折叠→重查→再折叠"死循环。判定以本字段为准，命名关键词（view/list/detail）兜底。
  readonly?: boolean;
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

  // 可选：多步工具循环的止损配置（缺省用平台默认：30 步硬上限 + 重复工具/文本自动中断）。
  // 项目可覆盖阈值，通用性由平台层保证。
  loopGuard?: LoopGuardOptions;

  // 可选：采样温度（采样随机性）。缺省用平台默认低温 0.2（抑制发散、降低幻觉）。
  // 统一主题"外部确定性 > 内部猜测"，但只对需要"事实/数据"的问题负责：
  // 开放性问题（起草文案、解释、给建议、头脑风暴）需要更高随机性，接入方可按意图提温。
  temperature?: number;

  // 可选：按意图覆盖温度。优先级高于 temperature（可省：命中则用，未命中回落 temperature/平台默认）。
  // 与 classifyIntent 配合：项目在 classifyIntent 里返回意图（如 query/general/writing），
  // 平台据此选温度 —— 数据查询类低温度保真，开放/创作类提温释放表达。
  intentTemperature?: Record<string, number>;

  // 可选：自定义创建 LLM model 实例（DAG 模式优先使用；缺省走平台 DeepSeek model）
  createModel?: () => LanguageModel;

  // 可选：数据查询能力的后端驱动（DatabaseBackend）。接入方显式注入自己的只读查询后端
  // （可选复用 createMssqlBackend，或自实现包装自己的权限/网关）。存在则中台自动注入
  // context.database，供 list_tables / describe_table / sample_rows / run_sql 取用。
  database?: DatabaseBackend;

  // 可选：observe_state 的精简概览钩子（返回文本摘要）。
  // 项目在 resolveContext 里把 summarizeState 挂到 context；存在则 observe_state 优先用它，
  // 返回 { summary }；缺省回退 context.getState，返回完整 { state }（大对象由 toAISDKTools 外置）。
  summarizeState?: (params: { context: AgentContext; focus?: string }) => string | Promise<string>;
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
  // 本轮关键产物（只读 SQL 路径里即生成的查询）。失败/被拦截的轮次也记录，看到全过程
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
