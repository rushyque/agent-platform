import { randomUUID } from "node:crypto";
import { streamText, type LanguageModel } from "ai";
import { EventType } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import type {
  DAGDefinition,
  DAGStep,
  ToolDefinition,
  AgentContext,
} from "../../types/agent-config.js";
import { saveCheckpoint } from "./checkpoint.js";
import { stageToolResult } from "../context/artifact-store.js";
import { DEFAULT_POLICY } from "../context/policy.js";
import { observeBus } from "../../observe/bus.js";
import { logger } from "../../observe/logger.js";
import { reasoningEffortProviderOptions } from "../llm.js";
import { settings } from "../../config/settings.js";

// DAG 执行上下文
export interface DAGExecutionContext {
  threadId: string;
  runId: string;
  agentId: string;
  messages: Message[];
  context: AgentContext;
  tools: ToolDefinition[];
  createModel: () => LanguageModel;
  emit: (event: any) => void;
  abortSignal?: AbortSignal;
}

// 从 state 中按点号路径取值
function getStateValue(state: Record<string, any>, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), state);
}

// 把 prompt 里的 ${state.path} 占位符替换为实际值（对象/数组序列化为 JSON）
function interpolate(prompt: string, state: Record<string, any>): string {
  return prompt.replace(/\$\{state\.([a-zA-Z0-9_.]+)\}/g, (_match, path: string) => {
    const value = getStateValue(state, path);
    if (value == null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function resolveNext(step: DAGStep, state: Record<string, any>): string {
  return typeof step.next === "function" ? step.next(state) : step.next;
}

// 主执行循环
export async function executeDAG(
  definition: DAGDefinition,
  ctx: DAGExecutionContext
): Promise<Record<string, any>> {
  const stepsById = new Map<string, DAGStep>();
  for (const step of definition.steps) stepsById.set(step.id, step);

  const state: Record<string, any> = {};

  // 从第一个 step 开始
  let currentStepId = definition.steps[0]?.id;
  // 防死循环：限制最大步数
  const MAX_STEPS = 50;
  let stepCount = 0;

  while (currentStepId && currentStepId !== "__end__" && stepCount < MAX_STEPS) {
    stepCount++;
    const step = stepsById.get(currentStepId);
    if (!step) throw new Error(`DAG step not found: ${currentStepId}`);

    ctx.emit({ type: EventType.STEP_STARTED, stepId: step.id });
    observeBus.emit("runs", "run.step", {
      runId: ctx.runId,
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      stepIndex: stepCount,
      type: step.type as "tool" | "llm" | "condition" | "transform",
      stepId: step.id,
    });

    // 每步执行后保存检查点（容错：中断后可从断点续跑）
    try {
      await executeStep(step, state, ctx, stepCount);
      await saveCheckpoint(ctx.threadId, step.id, state).catch((err) =>
        logger.for("DAG").error("checkpoint save failed", { step: step.id, err: (err as Error).message })
      );
    } catch (err) {
      ctx.emit({
        type: EventType.RUN_ERROR,
        message: `DAG step "${step.id}" failed: ${(err as Error).message}`,
        code: "DAG_STEP_ERROR",
      });
      throw err;
    }

    ctx.emit({ type: EventType.STEP_FINISHED, stepId: step.id });
    currentStepId = resolveNext(step, state);
  }

  if (stepCount >= MAX_STEPS) {
    throw new Error(`DAG exceeded max steps (${MAX_STEPS}), possible cycle`);
  }

  return state;
}

async function executeStep(
  step: DAGStep,
  state: Record<string, any>,
  ctx: DAGExecutionContext,
  stepIndex: number
): Promise<void> {
  switch (step.type) {
    case "tool":
      await executeToolStep(step, state, ctx, stepIndex);
      break;
    case "llm":
      await executeLLMStep(step, state, ctx, stepIndex);
      break;
    case "condition":
      // condition 步骤在 resolveNext 中通过 step.next(state) 决定跳转；
      // 此处若提供了 condition 函数也执行一次（可做副作用/日志），不改变 state
      if (step.condition) step.condition(state);
      break;
    case "transform":
      if (step.transform) {
        const transformed = step.transform(state);
        Object.assign(state, transformed);
      }
      break;
  }
}

async function executeToolStep(
  step: DAGStep,
  state: Record<string, any>,
  ctx: DAGExecutionContext,
  stepIndex: number
): Promise<void> {
  const tool = ctx.tools.find((t) => t.name === step.toolName);
  if (!tool) throw new Error(`DAG tool not found: ${step.toolName}`);

  const args = step.toolArgs ? step.toolArgs(state) : {};
  const toolCallId = `dagtool-${randomUUID()}`;
  const t0 = Date.now();
  observeBus.emit("runs", "run.tool_call", {
    runId: ctx.runId,
    threadId: ctx.threadId,
    agentId: ctx.agentId,
    toolName: tool.name,
    args,
  });

  ctx.emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: tool.name });
  ctx.emit({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: JSON.stringify(args),
  });
  ctx.emit({ type: EventType.TOOL_CALL_END, toolCallId });

  const result = await tool.execute(args, ctx.context);

  // 工具结果分级（与 Hermes 路径一致）：预算内完整内联，超过才外置为 {ref,summary,full:false}。
  // state 仍存完整 result —— DAG 为确定性编排、步数有限，后续 LLM 步用 ${state.stepId} 插值需要完整数据。
  const staged = await stageToolResult(result, {
    maxInlineChars: settings.TOOL_INLINE_MAX_CHARS,
    threadId: ctx.threadId,
    runId: ctx.runId,
    toolName: tool.name,
    args,
    summaryChars: DEFAULT_POLICY.toolResultSummaryChars,
  });
  const emitted = staged.inline
    ? result
    : { ref: staged.ref, toolName: tool.name, summary: staged.summary, full: false };
  observeBus.emit("runs", "run.tool_result", {
    runId: ctx.runId,
    threadId: ctx.threadId,
    agentId: ctx.agentId,
    toolName: tool.name,
    execMs: Date.now() - t0,
    summary: staged.summary,
    ref: staged.ref,
    inline: staged.inline,
  });

  ctx.emit({
    type: EventType.TOOL_CALL_RESULT,
    toolCallId,
    messageId: `${toolCallId}-result`,
    role: "tool",
    content: JSON.stringify(emitted),
  });

  // 结果写入 state（用 step.id 作为 key，便于后续 prompt 引用）
  state[step.id] = result;
}

async function executeLLMStep(
  step: DAGStep,
  state: Record<string, any>,
  ctx: DAGExecutionContext,
  stepIndex: number
): Promise<void> {
  if (!step.prompt) throw new Error(`DAG llm step "${step.id}" missing prompt`);

  const system = interpolate(step.prompt, state);
  const messageId = `dagmsg-${randomUUID()}`;
  let reasoningOpen = false;

  ctx.emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });

  observeBus.emit("runs", "run.llm_call", {
    runId: ctx.runId,
    threadId: ctx.threadId,
    agentId: ctx.agentId,
    systemPrompt: system,
    messages: ctx.messages,
    stepIndex,
  });

  const result = streamText({
    model: ctx.createModel(),
    ...reasoningEffortProviderOptions(),
    system,
    messages: ctx.messages as any,
    abortSignal: ctx.abortSignal,
  });

  let fullText = "";
  for await (const part of result.fullStream as any) {
    if (part.type === "text-delta") {
      // ai v5 + openai.chat 的 text-delta 携带 text 字段（实测，亦为 CopilotKit 转换器所读）
      const text = part.text ?? part.delta ?? "";
      fullText += text;
      ctx.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text,
      });
    } else if (part.type === "reasoning-start") {
      if (!reasoningOpen) {
        reasoningOpen = true;
        ctx.emit({ type: EventType.REASONING_START, id: messageId });
      }
    } else if (part.type === "reasoning-delta") {
      ctx.emit({
        type: EventType.REASONING_MESSAGE_CONTENT,
        id: messageId,
        delta: part.delta ?? "",
      });
    } else if (part.type === "reasoning-end") {
      // 由循环末尾统一收尾
    } else if (part.type === "error") {
      throw new Error(`LLM stream error: ${(part as any).error?.message ?? "unknown"}`);
    }
  }

  if (reasoningOpen) {
    ctx.emit({ type: EventType.REASONING_END, id: messageId });
  }
  ctx.emit({ type: EventType.TEXT_MESSAGE_END, messageId });

  // usage/finishReason 在 AI SDK v5 是 promise；DeepSeek 偶发不返 usage，标可选
  let usage: any = null;
  let finishReason: any = undefined;
  try {
    usage = await result.usage;
    finishReason = await result.finishReason;
  } catch { /* swallow */ }
  observeBus.emit("runs", "run.llm_response", {
    runId: ctx.runId,
    threadId: ctx.threadId,
    agentId: ctx.agentId,
    rawText: fullText,
    usage: usage
      ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
      : null,
    finishReason,
    stepIndex,
  });

  // 写入 state，供下游引用
  const outputKey = step.outputKey ?? step.id;
  state[outputKey] = fullText;
}
