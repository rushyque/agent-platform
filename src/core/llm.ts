import { wrapLanguageModel, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { settings } from "../config/settings.js";
import { createCompactionMiddleware } from "./context/compactor.js";
import { logger } from "../observe/logger.js";

// 把 openai 推理强度（reasoning_effort）拼成 streamText 的 providerOptions 片段。
// deepseek-v4-flash 网关默认不出思考体，须显式传该参数触发；GLM 不认此参数，留空即不传。
// 返回空对象时可直接用 ... 展开，避免给全部调用方再加条件判断。
export function reasoningEffortProviderOptions(): Record<string, unknown> {
  const effort = settings.REASONING_EFFORT;
  return effort && effort !== "none"
    ? { providerOptions: { openai: { reasoningEffort: effort } } }
    : {};
}

// DeepSeek Reasoning 中间件
// 从 DeepSeek 的 raw chunk 中提取 reasoning_content 字段，
// 注入为标准 AI SDK reasoning-* 流事件（低层级 doStream 流）。
//
// 注意：此中间件用 v2 的 wrapStream 钩子，只拦截 doStream 路径。
// generateObject 走 doGenerate，reasoning 提取不会触发——
// NL→SQL 子 agent（generateObject）路径下推理过程不可见，但不影响 SQL 生成。
export const deepseekReasoningMiddleware = {
  middlewareVersion: "v2" as const,
  transformParams: async ({ params }: any) => ({
    ...params,
    includeRawChunks: true,
  }),
  wrapStream: async ({ doStream }: any) => {
    const result = await doStream();

    let reasoningOpen = false;
    const reasoningId = `reasoning-${Date.now()}`;

    // 流式卡顿检测：记录相邻 chunk 间隔，>500ms 告警。
    // 用于定位"吐字中途突然卡住"是否来自 DeepSeek 侧（chunk 进中台的第一站，不受下游影响）。
    let lastTs = 0;
    let lastType = "";

    const transformedStream = new TransformStream({
      transform(chunk: any, controller: any) {
        const now = Date.now();
        if (lastTs > 0) {
          const gap = now - lastTs;
          if (gap > 500) {
            logger.for("stall").info("stream gap", { gap, after: lastType, before: chunk.type });
          }
        }
        lastTs = now;
        lastType = chunk.type;

        if (chunk.type === "raw" && chunk.rawValue) {
          try {
            const raw =
              typeof chunk.rawValue === "string"
                ? JSON.parse(chunk.rawValue)
                : chunk.rawValue;
            const delta = raw?.choices?.[0]?.delta;
            // DeepSeek 官方 / GLM 走 reasoning_content；本地 vLLM 网关(deepseekv4flash)走 reasoning，
            // 两者都读，否则该网关的思考体会静默丢失。
            const reasoningPiece = delta?.reasoning_content ?? delta?.reasoning;

            if (reasoningPiece) {
              if (!reasoningOpen) {
                reasoningOpen = true;
                controller.enqueue({ type: "reasoning-start", id: reasoningId });
              }
              controller.enqueue({
                type: "reasoning-delta",
                id: reasoningId,
                delta: reasoningPiece,
              });
            } else if (reasoningOpen && (delta?.content || raw?.choices?.[0]?.finish_reason)) {
              controller.enqueue({ type: "reasoning-end", id: reasoningId });
              reasoningOpen = false;
            }
          } catch {
            // JSON parse failure, skip
          }
        }
        controller.enqueue(chunk);
      },
      flush(controller: any) {
        if (reasoningOpen) {
          controller.enqueue({ type: "reasoning-end", id: reasoningId });
        }
      },
    });

    return { ...result, stream: result.stream.pipeThrough(transformedStream) };
  },
};

// 默认低温：抑制 DeepSeek 发散、降低幻觉。调用方显式传 temperature 时不覆盖。
// 统一主题——"外部确定性 > 内部猜测"：低温是给模型加确定性约束的一环。
const DEFAULT_TEMPERATURE = 0.2;
function createTemperatureMiddleware(override?: number) {
  const t = override ?? DEFAULT_TEMPERATURE;
  return {
    middlewareVersion: "v2" as const,
    transformParams: async ({ params }: any) => ({
      ...params,
      temperature: params.temperature ?? t,
    }),
  };
}

// 创建 LLM 客户端（包装 DeepSeek reasoning + 上下文压缩 + 低温 中间件）。
// 上下文压缩中间件在每次模型调用前（含 AI SDK 多步循环内部每一步）裁剪 prompt，
// 工具结果外置后只带 ref+summary，旧内容折叠/摘要——避免长 context 触发 DeepSeek 幻觉。
// opts.readonlyTools：per-run 闭包传入该 run 激活的只读工具名，让压缩按 readonly 声明判定。
// opts.temperature：覆盖默认低温。
export function createLLMClient(
  modelOverride?: string,
  opts?: { readonlyTools?: Set<string>; temperature?: number }
): LanguageModel {
  const model = modelOverride || settings.DEEPSEEK_MODEL;
  const openai = createOpenAI({
    apiKey: settings.DEEPSEEK_API_KEY,
    baseURL: settings.DEEPSEEK_BASE_URL,
  });
  // DeepSeek 兼容 OpenAI 协议（仅 /chat/completions）。
  // @ai-sdk/openai v2 中 openai(model) 默认走 Responses API（/responses），DeepSeek 不支持，
  // 必须用 openai.chat(model) 走 Chat Completions；否则 404。
  const baseModel = (openai as any).chat(model);
  return wrapLanguageModel({
    model: baseModel,
    middleware: [
      deepseekReasoningMiddleware,
      createCompactionMiddleware({ readonlyTools: opts?.readonlyTools }),
      createTemperatureMiddleware(opts?.temperature),
    ],
  });
}
