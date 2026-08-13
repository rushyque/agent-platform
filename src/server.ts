import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CopilotRuntime } from "@copilotkit/runtime";
import { BuiltInAgent, convertMessagesToVercelAISDKMessages } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { tool, streamText } from "ai";
import { createLLMClient, reasoningEffortProviderOptions } from "./core/llm.js";
import { resolveAgent, getAllAgentIds } from "./core/agent-router.js";
import { listRuns } from "./persistence/run-store.js";
import { listThreads } from "./persistence/thread-store.js";
import { getEvents } from "./persistence/event-store.js";
import { compactEvents, EventType } from "@ag-ui/client";
import { extractToken, verifyToken } from "./core/middleware/auth.js";
import { selectToolsForRun, createRunHooks } from "./core/middleware/index.js";
import { createLoopGuard } from "./core/middleware/loop-guard.js";
import {
  checkRateLimit,
  trackStart,
  trackEnd,
  rateLimitLog,
} from "./core/middleware/rate-limit.js";
import { handleProjectRoutes } from "./core/http-router.js";
import { handleBenchRoutes } from "./bench/bench-routes.js";
import {
  handleObserveRoutes,
  logger,
  logEvent,
  runWithCtx,
  observeBus,
} from "./observe/index.js";
import { DAGAgent } from "./core/dag/dag-agent.js";
import { DatabaseAgentRunner } from "./persistence/database-runner.js";
import { ensureSchema } from "./persistence/db.js";
import { startCleanup } from "./persistence/cleanup.js";
import { settings } from "./config/settings.js";
import { registerAllProjects } from "./projects/index.js";
import type { ToolDefinition, AgentContext } from "./types/agent-config.js";
import { stageToolResult, getArtifact } from "./core/context/artifact-store.js";
import { normalizeChoiceResponse } from "./core/render/index.js";
import { DEFAULT_POLICY, getThreadSummary } from "./core/context/index.js";
import {
  createToolDedupCache,
  replayDedup,
  schemaKeys,
  toolSignature,
} from "./core/middleware/tool-dedup.js";
import {
  composePrompt,
  compactionProtocol,
  choicesProtocol,
  toolFirstProtocol,
  structuredOutputGuide,
} from "./core/prompt/index.js";
import { renderBlocksToText, validateBlocks } from "./core/render/index.js";
import { z } from "zod";

// 进程级兜底：底层 tedious 在 MSSQL 登录失败/断连时会 emit 无监听器的 'error' 事件，
// 成为 uncaughtException 把整个服务打挂。本服务为 DB-optional（DB 不可用时按请求降级），
// 故捕获此类 DB 连接错误并记日志，不让其终止进程；其它异常仍如实抛出。
function isDbConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (err as any)?.code === "ELOGIN" ||
    (err as any)?.code === "ESOCKET" ||
    /登录失败|ConnectionError|Connection pool failed|tedious/i.test(msg)
  );
}
process.on("uncaughtException", (err) => {
  if (isDbConnectionError(err)) {
    logEvent({
      level: "warn",
      source: "DB",
      event: "db_connection_error_swallowed",
      message: "数据库连接错误已吞并，服务保持运行",
      data: { err },
    });
    return;
  }
  logEvent({
    level: "error",
    source: "UncaughtException",
    event: "process_fatal",
    message: "进程级未捕获异常，即将退出",
    data: { err },
  });
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  if (isDbConnectionError(err)) {
    logEvent({
      level: "warn",
      source: "DB",
      event: "db_connection_error_swallowed",
      message: "数据库连接 rejection 已吞并",
      data: { err },
    });
    return;
  }
  logEvent({
    level: "error",
    source: "UnhandledRejection",
    event: "process_unhandled_rejection",
    message: "未处理的 Promise rejection",
    data: { err },
  });
});

// DeepSeek LLM 客户端（createLLMClient + reasoning 中间件）已抽到 ./core/llm.ts，
// 供 server（DAG / Hermes）与工具层（extract 等 generateObject 结构提取）共用。

// 将 AgentConfig 的 ToolDefinition 转换为 AI SDK tool 记录。
// 工具结果一律外置到 artifact 表，context 里只回 {ref, toolName, summary}；
// 模型需要完整数据时调 getArtifact(ref) 取回（见 factory 内注入）。
function toAISDKTools(
  configTools: ToolDefinition[],
  context: AgentContext,
  threadId: string,
  runId: string,
  agentId: string,
  dedupCache?: Map<string, { result: unknown; inline: boolean }>
): Record<string, any> {
  return Object.fromEntries(
    configTools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.parameters,
        execute: async (args: any) => {
          const ctx = { runId, threadId, agentId };
          // 同签名幂等去重：命中则回放上次内联结果，不再重跑后端查询。
          if (dedupCache && t.readonly) {
            const keys = schemaKeys(t.parameters);
            const hit = replayDedup(dedupCache, t.name, args, keys);
            if (hit) {
              logEvent({
                level: "info",
                source: "tool",
                event: "tool_dedup_replay",
                message: "同签名工具结果去重回放",
                data: { tool: t.name, args },
              });
              observeBus.emit("runs", "run.tool_result", {
                runId, threadId, agentId, toolName: t.name,
                execMs: 0, summary: "去重回放（同签名内联结果）", ref: null, inline: true,
              });
              return hit.replay;
            }
          }
          // 包进 ALS：工具体内（含其同步/异步子调用）的 logger 自动带 runId 归属。
          return runWithCtx(
            { ...ctx, userId: context.userId, route: "hermes" },
            async () => {
              const t0 = Date.now();
              observeBus.emit("runs", "run.tool_call", {
                runId, threadId, agentId, toolName: t.name, args,
              });
              logEvent({
                level: "debug",
                source: "tool",
                event: "tool_call",
                message: "工具调用开始",
                data: { tool: t.name, args },
              });
              let result: any;
              try {
                result = await t.execute(args, context);
              } catch (err) {
                // 工具抛异常 → 统一 error 信封，让前端能区分"真错误(红)"与"业务拒绝 ok:false(琥珀)"
                const msg = (err as Error)?.message ?? String(err);
                logEvent({
                  level: "error",
                  source: "tool",
                  event: "tool_failed",
                  message: "工具调用失败",
                  data: { tool: t.name, err },
                });
                observeBus.emit("runs", "run.tool_result", {
                  runId, threadId, agentId, toolName: t.name,
                  execMs: Date.now() - t0, summary: `工具执行异常: ${msg}`, ref: null,
                });
                return JSON.stringify({ ok: false, error: true, message: `工具执行异常: ${msg}` });
              }
              const execMs = Date.now() - t0;
              // 工具结果分级：结果在预算内直接完整内联回上下文（模型拿到全量即可作答，
              // 不必重查/取回，治绕圈）；超过预算才外置为 {ref, summary, full:false} 安全阀。
              // 编排层（领域工具行数/列投影 + run_sql TOP 上限）已保证典型结果尺度小，
              // 内联是默认路径，外置降级为真正溢出时防护。
              const staged = await stageToolResult(result, {
                maxInlineChars: settings.TOOL_INLINE_MAX_CHARS,
                threadId,
                runId,
                toolName: t.name,
                args,
                summaryChars: DEFAULT_POLICY.toolResultSummaryChars,
              });
              logEvent({
                level: "info",
                source: "tool",
                event: "tool_result",
                message: "工具调用完成",
                data: {
                  tool: t.name,
                  duration_ms: execMs,
                  result_chars: JSON.stringify(result).length,
                  inline: staged.inline,
                  summary_chars: staged.summary.length,
                  stored: !!staged.ref,
                },
              });
              observeBus.emit("runs", "run.tool_result", {
                runId, threadId, agentId, toolName: t.name, execMs,
                summary: staged.summary, ref: staged.ref, inline: staged.inline,
              });
              if (dedupCache && t.readonly && staged.inline) {
                dedupCache.set(toolSignature(t.name, args), { result, inline: true });
              }
              // 内联 → 回完整 result；外置 → 只回 ref + summary，并显式 full:false，
              // 让模型清楚"手上只有摘要、可按需取回"，消除"分不清是否已有数据"的重查歧义。
              return JSON.stringify(
                staged.inline
                  ? result
                  : { ref: staged.ref, toolName: t.name, summary: staged.summary, full: false }
              );
            }
          );
        },
      }),
    ])
  );
}

// ===== 平台决策捕获（供 /debug 调试台展示 agent 的"思考过程"）=====
// 工厂里算出的路由/意图/工具子集/角色等决策，AG-UI 事件流里没有，这里按 runId 暂存，
// 由 /debug/api/runs/:runId/meta 暴露给前端，让一次 run 看起来像 agent 轨迹而非扁平聊天。
interface RunMeta {
  runId: string;
  threadId: string;
  agentId: string;
  route: "hermes" | "dag";
  intent: string;
  selectedTools: string[];
  totalTools: number;
  role: string;
  userId: string;
  model: string;
  startedAt: string;
}
const RUN_META_MAX = 200;
const runMetaStore = new Map<string, RunMeta>();

function recordRunMeta(meta: RunMeta): void {
  runMetaStore.set(meta.runId, meta);
  // 简单上限：超过则删最早的（Map 保持插入序）
  if (runMetaStore.size > RUN_META_MAX) {
    const firstKey = runMetaStore.keys().next().value;
    if (firstKey) runMetaStore.delete(firstKey);
  }
}

// 创建 CopilotKit Runtime。
// runner 用 DatabaseAgentRunner（事件持久化到 MSSQL，connect 恢复历史）。
// agents factory 按请求动态构建：解析上下文 → 意图分类 → 工具选择 → DAG/Hermes 路由。
const runtime = new CopilotRuntime({
  runner: new DatabaseAgentRunner(),
  agents: async ({ request }) => {
    // 1. 从 HTTP 请求中提取 JWT
    const authHeader =
      request.headers.get("authorization") ||
      request.headers.get("Authorization");

    const token = extractToken(authHeader);
    // 端到端 traceId：沿用入口生成的 x-trace-id（若无则容错生成，保证 run 事件也有 traceId）
    const traceId = request.headers.get("x-trace-id") || randomUUID();

    // 2. 解析用户基本信息
    let userId = "anonymous";
    if (token) {
      const decoded = verifyToken(token, settings.JWT_SECRET);
      if (decoded) userId = decoded.userId || decoded.id || decoded.sub || "unknown";
    }

    // 3. 从 URL 路径提取 agentId（multi-route 必须显式指定，平台不兜底到任何项目）
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/\/agent\/([^/]+)/);
    if (!pathMatch) {
      const errorMsg =
        "未指定 agentId。请通过 /agent/{agentId}/run 访问具体项目 agent。";
      return {
        default: new BuiltInAgent({
          type: "aisdk",
          factory: () => ({
            fullStream: (async function* () {
              yield { type: "text-delta", text: errorMsg };
              yield { type: "finish" };
            })(),
          }),
        }),
      };
    }
    const agentId = pathMatch[1];

    // 4. 查找 AgentConfig
    const config = resolveAgent(agentId);
    if (!config) {
      const errorMsg = `系统错误: 未找到 agent "${agentId}" 的配置。请检查 agentId 是否正确。`;
      return {
        [agentId]: new BuiltInAgent({
          type: "aisdk",
          factory: () => ({
            fullStream: (async function* () {
              yield { type: "text-delta", text: errorMsg };
              yield { type: "finish" };
            })(),
          }),
        }),
      };
    }

    // 5. 解析上下文
    const context = await config.resolveContext({
      userId,
      token: token || "",
      headers: Object.fromEntries(request.headers.entries()),
    });
    // 平台通用注入：前端每轮把"当前页面可用动作清单（含风险标注）"经 x-ui-actions
    // 请求头上报，挂到 context.uiActions，供 ui_click 工具校验与模型选动作。
    // 这是平台级公共能力，任何接入项目的前端都可上报，不依赖具体项目实现。
    const uiActionsHeader = request.headers.get("x-ui-actions");
    if (uiActionsHeader) {
      try {
        const decoded = decodeURIComponent(uiActionsHeader);
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed)) context.uiActions = parsed;
      } catch {
        logger.for("Run").warn("x-ui-actions header parse failed", {});
      }
    }
    // 平台级对话模式注入：前端经 X-Chat-Mode 上报（browse/act/full），挂到 context.chatMode。
    // 平台据此裁剪工具（browse 不暴露 ui_click）并让 ui_click 决定点击/确认/高亮行为，
    // 任何接入项目的前端都可上报，是平台级公共能力。缺省回落到 "act"（行动模式）。
    const chatModeHeader = request.headers.get("x-chat-mode");
    const chatMode = chatModeHeader === "browse" || chatModeHeader === "full" ? chatModeHeader : "act";
    context.chatMode = chatMode;
    // 平台 meta 注入：若 AgentConfig 提供 database（DatabaseBackend），挂到 context，
    // 供 list_tables / describe_table / sample_rows / run_sql 从 context.database 取用（免项目在 resolveContext 手动塞）。
    if (config.database) context.database = config.database;

    // 6. 路由：DAG（Harness）vs BuiltInAgent（Hermes）
    if (config.dagDefinition) {
      const dagAgent = new DAGAgent({
        agentId,
        description: config.description ?? agentId,
        dagDefinition: config.dagDefinition,
        tools: config.tools,
        context,
        createModel: () => createLLMClient(config.model),
        onRunStart: (input: any) => {
          // DAG 路由：确定性编排，无意图分类；selectedTools 取 DAG 实际引用的工具名
          const usedToolNames = Array.from(
            new Set(
              (config.dagDefinition?.steps ?? [])
                .map((s: any) => s.toolName)
                .filter(Boolean) as string[]
            )
          );
          recordRunMeta({
            runId: input.runId,
            threadId: input.threadId,
            agentId,
            route: "dag",
            intent: "dag",
            selectedTools: usedToolNames,
            totalTools: config.tools.length,
            role: context.role ?? "unknown",
            userId,
            model: config.model ?? settings.DEEPSEEK_MODEL,
            startedAt: new Date().toISOString(),
          });
        },
      });
      return { [agentId]: dagAgent };
    }

    // 7. Hermes 模式：按请求构建 BuiltInAgent
    return {
      [agentId]: new BuiltInAgent({
        type: "aisdk",
        factory: ({ input, abortSignal }: any) => {
          // 包进 ALS：factory 体内同步阶段（意图分类/prompt 构建）的 logger 带 run 归属。
          // streamText 回调与工具执行可能脱离本续体，故 runs 通道事件一律用下方闭包变量
          // （agentId/input.runId 等）显式传，不依赖 ALS。
          return runWithCtx(
            { runId: input.runId, threadId: input.threadId, agentId, userId, traceId, route: "hermes" },
            () => {
          // 用户选择交接：若最近一条用户消息是 `<CHOICE_SELECT .../>` 选择标记，
          // 归一化为类型化文本，让模型明确知道用户选了哪个选项（不是靠文本回显猜）。
          // normalizedMessages 同时用于意图分类 / prompt / hooks / 消息转换，保持单一口径。
          const { messages: runMessages, choice } = normalizeChoiceResponse(input.messages);
          if (choice) {
            logger.for("Factory").info("choice handoff", {
              agent: agentId, thread: input.threadId, value: choice.value,
            });
          }

          // 意图分类：项目可在 AgentConfig.classifyIntent 自带；缺省 "general"（平台不内置业务关键词）
          const intent = config.classifyIntent
            ? config.classifyIntent({ messages: runMessages, context })
            : "general";

          // 按意图选择工具子集
          const activeTools = selectToolsForRun({
            intent,
            allTools: config.tools,
            context,
            override: config.selectTools,
          });
          // 平台级硬边界（任何接入项目都生效）：
          //   1) 浏览模式：不暴露任何"前端动作触发/填表"工具（ui_click / ui_fill），模型只能返回结果/跳转；
          //   2) 非完全模式：裁剪掉声明 fullModeOnly 的工具（高风险写操作只在完全模式下可用），
          //      其他模式模型根本拿不到，无法误触发或绕过确认。
          const actionFilteredTools = activeTools.filter(
            (t) =>
              !(chatMode === "browse" && (t.name === "ui_click" || t.name === "ui_fill")) &&
              !(chatMode !== "full" && t.fullModeOnly)
          );
          // 按意图解出采样温度：intentTemperature 优先 > temperature > 平台默认（createLLMClient 内部 0.2）。
          // 数据/查询类低温度保真；开放/创作类可提温释放表达。undefined 时走平台默认，不透传也安全。
          const effectiveTemperature =
            config.intentTemperature?.[intent] ?? config.temperature;

          // 收集本 run 激活的只读工具名（按 ToolDefinition.readonly 声明），
          // 闭包传入 createLLMClient → 压缩中间件据此判定不折叠（命名关键词兜底）。
          const readonlyTools = new Set(
            actionFilteredTools.filter((t) => t.readonly).map((t) => t.name)
          );

          // 构建 system prompt（透传 intent，避免重复分类）+ 中台级上下文管理约定
          const prevSummary = getThreadSummary(input.threadId);
          const systemPrompt = composePrompt([
            config.buildSystemPrompt({
              context,
              messages: runMessages,
              intent,
            }),
            compactionProtocol(),
            toolFirstProtocol(),
            structuredOutputGuide(),
            choicesProtocol(),
            prevSummary
              ? `[上一阶段摘要（本线程延续上下文）]\n${prevSummary}`
              : undefined,
          ]);

          // 本次 run 的工具去重缓存：同签名只读查询第二次命中即回放上次内联结果，
          // 不再重跑后端（见 middleware/tool-dedup.ts）。
          const dedupCache = createToolDedupCache();
          const aiTools = {
            ...toAISDKTools(actionFilteredTools, context, input.threadId, input.runId, agentId, dedupCache),
            // 取回工具：当 compactor 把老 tool-result 折叠成 [已折叠 ... ref=art-xxx] 后，
            // 模型若需要其完整细节，主动调用本工具按 ref 拉取，而非被动背着完整结果。
            getArtifact: tool({
              description:
                "取回某个已折叠工具结果的完整原始数据。当上下文里出现 [已折叠 ... ref=art-xxx] 而你需要其完整细节时调用。",
              inputSchema: z.object({
                ref: z.string().describe("折叠占位里的 ref，形如 art-xxx"),
              }),
              execute: async ({ ref }: { ref: string }) => {
                try {
                  const art = await getArtifact(ref);
                  if (!art) return JSON.stringify({ error: "artifact not found", ref });
                  return JSON.stringify(art.result);
                } catch (err) {
                  return JSON.stringify({ error: (err as Error).message, ref });
                }
              },
            }),
            // render 兜底护栏：本平台默认"文本内联 <render>{json}</render>"是第一等输出
            // （前端统一解析，零截断）。若项目未装配 render 工具而模型仍把 render 当工具调用，
            // 这里不放行（避免前端无法消费 ui.render），而是把 blocks 转回内联文本并明确
            // 要求模型改以正文输出，从而让 render 通道的决定性自纠替代随机的"有时自纠、有时
            // 退化成纯文本"。项目已装配 render 工具时不会走到这里（下方按名称豁免）。
            ...(actionFilteredTools.some((t) => t.name === "render")
              ? {}
              : {
                  render: tool({
                    description:
                      "系统提示：本系统未装配 render 工具，不得把 render 当作工具调用。" +
                      "所有表格/指标卡/图表/选项等结构化内容，都必须在回复正文里用 <render>{json}</render> 内联输出。",
                    inputSchema: z.object({
                      blocks: z
                        .array(z.any())
                        .describe("你本打算渲染的块数组，会被原样转换成内联 <render> 回给你"),
                    }),
                    execute: async ({ blocks }: { blocks: any[] }) => {
                      logEvent({
                        level: "info",
                        source: "tool",
                        event: "render_tool_guard",
                        message: "模型把 render 当工具调用，已转内联文本提示其改正文输出",
                        data: { blockCount: Array.isArray(blocks) ? blocks.length : 0 },
                      });
                      let inline: string;
                      try {
                        const valid = validateBlocks(blocks);
                        inline = renderBlocksToText(valid);
                      } catch {
                        inline = JSON.stringify(blocks ?? []);
                      }
                      return (
                        `[内联引导] 本系统未装配 render 工具，请勿把 render 当作工具调用。` +
                        `以下内容应作为你的回复正文直接输出（含首尾 <render> 标签原样保留，前端会解析）：\n\n` +
                        `${inline}\n\n` +
                        `请在你的回复文本里输出这一整段 <render>{json}</render>，不要再调用 render 或任何其它工具来呈现它。`
                      );
                    },
                  }),
                }),
          };
          const messages = convertMessagesToVercelAISDKMessages(runMessages);
          const hooks = createRunHooks({
            agentId,
            userId,
            threadId: input.threadId,
            runId: input.runId,
            messages: runMessages,
            model: config.model ?? settings.DEEPSEEK_MODEL,
            intent,
          });

          logger.for("Factory").debug("hermes run", {
            agent: agentId,
            intent,
            tools: `${activeTools.length}/${config.tools.length}`,
            user: userId,
            role: context.role,
          });

          // 捕获平台决策，供调试台 Trace 条展示
          recordRunMeta({
            runId: input.runId,
            threadId: input.threadId,
            agentId,
            route: "hermes",
            intent,
            selectedTools: actionFilteredTools.map((t) => t.name),
            totalTools: actionFilteredTools.length,
            role: context.role ?? "unknown",
            userId,
            model: config.model ?? settings.DEEPSEEK_MODEL,
            startedAt: new Date().toISOString(),
          });

          observeBus.emit("runs", "run.started", {
            runId: input.runId,
            threadId: input.threadId,
            agentId,
            userId,
            route: "hermes",
            intent,
            selectedTools: actionFilteredTools.map((t) => t.name),
            totalTools: actionFilteredTools.length,
            role: context.role ?? "unknown",
            model: config.model ?? settings.DEEPSEEK_MODEL,
          });
          logEvent({
            level: "info",
            source: "run",
            event: "run_started",
            message: "run 开始",
            traceId,
            data: {
              intent,
              route: "hermes",
              selectedTools: actionFilteredTools.map((t) => t.name),
              totalTools: actionFilteredTools.length,
              role: context.role ?? "unknown",
              model: config.model ?? settings.DEEPSEEK_MODEL,
            },
          });

          return streamText({
            model: createLLMClient(config.model, {
              readonlyTools,
              temperature: effectiveTemperature,
            }),
            ...reasoningEffortProviderOptions(),
            system: systemPrompt,
            // ai v5 与 CopilotKit 已对齐：ModelMessage[] 直接透传
            messages: messages as any,
            tools: aiTools,
            abortSignal,
            // 通用循环止损：30 步硬上限 + 重复工具调用/重复文本提前中断（项目可经 config.loopGuard 覆盖）。
            stopWhen: createLoopGuard(config.loopGuard),
            // 每步开始发射 run.llm_call（带该步输入与 stepNumber）——治此前多步 run 只抓首步 prompt。
            // prepareStep 是 AI SDK v5 原生钩子，每步 doStream 前调用、自带 stepNumber，无需自维护计数器。
            // 与下方 onStepFinish 的 run.llm_response（stepIndex 从 0 起）逐步成对，RunTrace 每步输入可见。
            prepareStep: ({ stepNumber, messages: stepMessages }) => {
              observeBus.emit("runs", "run.llm_call", {
                runId: input.runId,
                threadId: input.threadId,
                agentId,
                systemPrompt,
                messages: stepMessages,
                stepIndex: stepNumber,
              });
              logEvent({
                level: "debug",
                source: "llm",
                event: "llm_call",
                message: "模型调用开始",
                traceId,
                data: {
                  stepIndex: stepNumber,
                  messageCount: Array.isArray(stepMessages) ? stepMessages.length : 0,
                  systemPromptChars: systemPrompt.length,
                },
              });
              return {}; // 纯观察，不覆盖 model/system/messages/toolChoice
            },
            onStepFinish: hooks.onStepFinish,
            onFinish: hooks.onFinish,
          });
          });
        },
      }),
    };
  },
});

// ===== 调试控制台：静态托管 public/ + 只读调试 API =====
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// 处理 /debug 与 /debug/api/* 请求。命中则写回响应并返回 true，否则返回 false 交给 CopilotKit listener。
async function handleDebugRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams
): Promise<boolean> {
  // 调试 API（只读）
  if (pathname === "/debug/api/agents") {
    const agents = getAllAgentIds().map((id) => {
      const cfg = resolveAgent(id);
      return {
        id,
        description: cfg?.description ?? "",
        hasDag: !!cfg?.dagDefinition,
      };
    });
    sendJson(res, 200, { agents });
    return true;
  }

  // 按 ref 取回完整 artifact（工具结果的完整原始返回）。
  // 前端拿到 TOOL_CALL_RESULT 的 {ref, summary} 后，若需要渲染完整内容
  // （表/图/文档等大负载，summary 只带 200 字预览），调本接口取回完整 JSON。
  const artMatch = pathname.match(/^\/debug\/api\/artifacts\/([^/]+)$/);
  if (artMatch) {
    try {
      const art = await getArtifact(decodeURIComponent(artMatch[1]));
      if (!art) {
        sendJson(res, 404, { error: "artifact not found", ref: artMatch[1] });
      } else {
        sendJson(res, 200, { ref: art.ref, toolName: art.toolName, result: art.result });
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message, ref: artMatch[1] });
    }
    return true;
  }

  if (pathname === "/debug/api/runs") {
    const threadId = query.get("threadId") || undefined;
    const limit = query.get("limit") ? Number(query.get("limit")) : undefined;
    try {
      const runs = await listRuns({ threadId, limit });
      sendJson(res, 200, { runs });
    } catch (err) {
      sendJson(res, 200, { runs: [], error: (err as Error).message });
    }
    return true;
  }

  // 某 run 的平台决策元数据（路由/意图/工具子集/角色，调试台 Trace 条用）
  const metaMatch = pathname.match(/^\/debug\/api\/runs\/([^/]+)\/meta$/);
  if (metaMatch) {
    const meta = runMetaStore.get(decodeURIComponent(metaMatch[1])) ?? null;
    sendJson(res, 200, { meta });
    return true;
  }

  // 线程列表（直读存储层；CopilotKit /threads 需 Intelligence 实例，本地回退被 telemetry 包装器遮蔽，故自建）
  if (pathname === "/debug/api/threads") {
    try {
      const threads = await listThreads();
      sendJson(res, 200, { threads });
    } catch (err) {
      sendJson(res, 200, { threads: [], error: (err as Error).message });
    }
    return true;
  }

  // 某线程 compacted 事件流（回放）
  const evMatch = pathname.match(/^\/debug\/api\/threads\/([^/]+)\/events$/);
  if (evMatch) {
    try {
      const events = compactEvents(await getEvents(decodeURIComponent(evMatch[1])));
      sendJson(res, 200, { events });
    } catch (err) {
      sendJson(res, 200, { events: [], error: (err as Error).message });
    }
    return true;
  }

  // 某线程消息历史（取最近一次 RUN_STARTED 的 input.messages）
  const msgMatch = pathname.match(/^\/debug\/api\/threads\/([^/]+)\/messages$/);
  if (msgMatch) {
    try {
      const events = await getEvents(decodeURIComponent(msgMatch[1]));
      let messages: unknown[] = [];
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === EventType.RUN_STARTED) {
          const m = (events[i] as any).input?.messages;
          if (Array.isArray(m)) { messages = m; break; }
        }
      }
      sendJson(res, 200, { messages });
    } catch (err) {
      sendJson(res, 200, { messages: [], error: (err as Error).message });
    }
    return true;
  }

  // 静态托管 public/（/debug → debug.html，/debug/x.js → public/x.js）
  if (pathname === "/debug" || pathname === "/debug/" || pathname.startsWith("/debug/")) {
    const rel = pathname === "/debug" || pathname === "/debug/" ? "debug.html" : pathname.slice("/debug/".length);
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: "Forbidden" });
      return true;
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Not found", path: rel });
    }
    return true;
  }

  return false;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// connections 通道：只记有意义的入口（AG-UI /agent/* + 项目路由 /game /inquiry），静态资源不计。
// console SPA 发请求时带 X-Observe-Origin: console 头，前端可据此区分自己的回环请求。
function trackRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const interesting =
    pathname.startsWith("/agent/") ||
    pathname === "/game" || pathname.startsWith("/game/") ||
    pathname === "/inquiry" || pathname.startsWith("/inquiry/");
  if (!interesting) return;

  // 端到端 traceId：入口带 x-trace-id 则沿用，否则生成并回写响应头，供 agent 工厂读取对齐。
  const traceHeader = req.headers["x-trace-id"];
  const incomingTraceId = Array.isArray(traceHeader) ? traceHeader[0] : traceHeader;
  const reqId = incomingTraceId || randomUUID();
  if (!incomingTraceId && !res.headersSent) {
    res.setHeader("x-trace-id", reqId);
  }
  const t0 = Date.now();
  const agentMatch = pathname.match(/\/agent\/([^/]+)/);
  const authHeader = (req.headers["authorization"] || req.headers["Authorization"]) as string | undefined;
  const token = extractToken(authHeader ?? null);
  let userId: string | undefined;
  if (token) {
    const decoded = verifyToken(token, settings.JWT_SECRET);
    if (decoded) userId = decoded.userId;
  }
  const fromConsole = req.headers["x-observe-origin"] === "console";
  observeBus.emit("connections", "request.started", {
    reqId,
    method: req.method || "GET",
    path: pathname,
    agentId: agentMatch?.[1],
    userId,
    ip: req.socket.remoteAddress || undefined,
    origin: fromConsole ? "console" : ((req.headers["origin"] || req.headers["referer"]) as string) || undefined,
    ua: (req.headers["user-agent"] as string) || undefined,
  });
  logEvent({
    level: "info",
    source: "request",
    event: "request_started",
    message: "请求开始",
    traceId: reqId,
    data: {
      reqId,
      method: req.method || "GET",
      path: pathname,
      agentId: agentMatch?.[1],
      origin: fromConsole ? "console" : "external",
    },
  });
  res.on("finish", () => {
    observeBus.emit("connections", "request.finished", {
      reqId,
      status: res.statusCode,
      durationMs: Date.now() - t0,
    });
    logEvent({
      level: res.statusCode >= 500 ? "error" : "info",
      source: "request",
      event: "request_finished",
      message: "请求完成",
      traceId: reqId,
      data: {
        reqId,
        path: pathname,
        method: req.method || "GET",
        status: res.statusCode,
        duration_ms: Date.now() - t0,
      },
    });
  });
}

// 启动 HTTP 服务器（异步 main：先建表再监听）
async function main() {
  // 注册所有项目
  registerAllProjects();

  // 初始化数据库 schema（失败仅告警，不阻断启动；DB 不可用时 run/connect 会按请求失败）
  try {
    await ensureSchema();
  } catch (err) {
    logger.for("Startup").error("ensureSchema failed, continuing without persisted schema", { err: (err as Error).message });
  }

  startCleanup(); // TTL 清理（事件/审计/artifact）；interval.unref 不阻止进程退出

  const listener = createCopilotNodeListener({
    runtime: runtime.instance,
    basePath: "/",
    mode: "multi-route",
    cors: true,
  });

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      // 限流与防滥用：基础配额 + /agent/* LLM 额外配额 + 全局并发兜底。
      // 命中限制直接返回 429/503，不进入业务处理（防刷、防熔断）。
      const clientIp = req.socket.remoteAddress || "unknown";
      const limit = checkRateLimit(req, clientIp);
      if (!limit.allowed) {
        rateLimitLog(clientIp, req.url || "/", limit.status, limit.message);
        res.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        res.writeHead(limit.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: limit.message, code: "RATE_LIMITED" }));
        return;
      }
      trackStart();
      res.on("close", trackEnd);

      // 调试控制台：静态页 + 只读 API（命中则不进 CopilotKit listener）
      const url = new URL(req.url || "/", "http://localhost");
      trackRequest(req, res, url.pathname);
      if (await handleDebugRoutes(req, res, url.pathname, url.searchParams)) {
        return;
      }
      // 观察控制台：/observe/stream (SSE) + /console (SPA) + /console/api/*
      if (await handleObserveRoutes(req, res, url.pathname, url.searchParams)) {
        return;
      }
      // 并发压测页：/bench + /bench/api/run（命中则不进 CopilotKit listener）
      if (await handleBenchRoutes(req, res, url.pathname, url.searchParams)) {
        return;
      }
      // 项目自有 HTTP 路由（如 /game），命中则不进 CopilotKit listener
      if (await handleProjectRoutes(req, res, url.pathname, url.searchParams)) {
        return;
      }
      await listener(req as any, res as any);
    } catch (err) {
      logEvent({
        level: "error",
        source: "Runtime",
        event: "request_failed",
        message: "请求处理失败",
        data: { path: req.url, err },
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error", detail: (err as Error).message }));
      }
    }
  });

  server.listen(settings.RUNTIME_PORT, settings.RUNTIME_HOST, () => {
    logEvent({
      level: "info",
      source: "Startup",
      event: "app_started",
      message: "服务启动完成",
      data: {
        version: "0.1.0",
        listen: `http://${settings.RUNTIME_HOST}:${settings.RUNTIME_PORT}`,
        agents: getAllAgentIds(),
      },
    });
    logger.for("Startup").info("runtime listening", { url: `http://${settings.RUNTIME_HOST}:${settings.RUNTIME_PORT}` });
    logger.for("Startup").info("LLM", { base: settings.DEEPSEEK_BASE_URL, model: settings.DEEPSEEK_MODEL });
    logger.for("Startup").info("registered agents", { agents: getAllAgentIds() });
    logger.for("Startup").info("observe console ready", {
      stream: "/observe/stream",
      console: "/console",
      enabled: settings.OBSERVE_ENABLED,
    });
  });
}

main().catch((err) => {
  logEvent({
    level: "error",
    source: "Startup",
    event: "process_fatal",
    message: "启动失败，进程退出",
    data: { err },
  });
  process.exit(1);
});
