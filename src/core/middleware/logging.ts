import { recordRun } from "../../persistence/run-store.js";
import {
  getThreadSummary,
  setThreadSummary,
  rollupThreadSummary,
  DEFAULT_POLICY,
} from "../context/index.js";
import { observeBus } from "../../observe/bus.js";
import { logger, logEvent } from "../../observe/logger.js";

// 审计 + token 计费 + 线程滚动摘要钩子。
// onStepFinish 记每步；onFinish 记总览（agent_runs，DB 挂降级）并把本次对话压进 thread_summary，
// 作为下次 run 注入 system 的延续上下文。原始历史不保留。

export interface RunHooksParams {
  agentId: string;
  userId: string | null;
  threadId: string;
  runId: string;
  messages?: any[];
  model?: string | null;
  intent?: string | null;
}

// 从 steps + user 消息构造本次对话的可摘要文本
function buildRunText(steps: any[], messages?: any[]): string {
  const parts: string[] = [];
  const userTexts = (messages || [])
    .filter((m: any) => m?.role === "user")
    .map((m: any) =>
      typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")
    );
  if (userTexts.length) parts.push(`用户: ${userTexts[userTexts.length - 1].slice(0, 500)}`);
  (steps || []).forEach((s: any, i: number) => {
    const bits: string[] = [];
    if (s?.text) bits.push(String(s.text).slice(0, 400));
    if (Array.isArray(s?.toolCalls) && s.toolCalls.length) {
      bits.push(`[调用工具: ${s.toolCalls.map((tc: any) => tc.toolName).join(",")}]`);
    }
    if (bits.length) parts.push(`步骤${i + 1}: ${bits.join(" ")}`);
  });
  return parts.join("\n");
}

export function createRunHooks(params: RunHooksParams) {
  const { agentId, userId, threadId, runId, messages, model, intent } = params;
  const startedAt = Date.now();
  let stepIndex = -1;

  return {
    onStepFinish: ({ text, toolCalls, toolResults, usage, finishReason }: any) => {
      stepIndex++;
      const elapsed = Date.now() - startedAt;
      const tools =
        toolCalls && toolCalls.length > 0
          ? toolCalls.map((tc: any) => tc.toolName)
          : [];
      observeBus.emit("runs", "run.llm_response", {
        runId,
        threadId,
        agentId,
        rawText: typeof text === "string" ? text : "",
        usage: usage
          ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
          : null,
        finishReason,
        stepIndex,
      });
      logEvent({
        level: "debug",
        source: "llm",
        event: "llm_response",
        message: "模型调用完成",
        data: {
          stepIndex,
          finishReason,
          textChars: typeof text === "string" ? text.length : 0,
          promptTokens: usage?.promptTokens ?? null,
          completionTokens: usage?.completionTokens ?? null,
        },
      });
      logger.for("Audit").info("step", {
        agent: agentId,
        thread: threadId,
        elapsedMs: elapsed,
        finishReason,
        tools,
        textLen: text?.length ?? 0,
      });
    },

    onFinish: async ({ steps, usage, finishReason }: any) => {
      const stepCount = Array.isArray(steps) ? steps.length : 0;
      const promptTokens = usage?.promptTokens ?? null;
      const completionTokens = usage?.completionTokens ?? null;
      const totalMs = Date.now() - startedAt;
      observeBus.emit("runs", "run.finished", {
        runId,
        threadId,
        agentId,
        status: finishReason === "error" ? "error" : "ok",
        durationMs: totalMs,
      });
      logEvent({
        level: finishReason === "error" ? "error" : "info",
        source: "run",
        event: "run_finished",
        message: finishReason === "error" ? "run 结束（异常）" : "run 完成",
        data: {
          status: finishReason === "error" ? "error" : "ok",
          duration_ms: totalMs,
          steps: stepCount,
          finishReason,
          promptTokens,
          completionTokens,
        },
      });
      logger.for("Audit").info("run done", {
        agent: agentId,
        thread: threadId,
        durationMs: totalMs,
        steps: stepCount,
        finishReason,
        prompt: promptTokens ?? "n/a",
        completion: completionTokens ?? "n/a",
      });

      // 线程滚动摘要：上次摘要 + 本次对话 → 新单段，覆写存内存，下次 run 注入 system。
      // 异步 fire-and-forget：rollup 调 LLM 需 2-4s，不阻塞 run 收尾（用户不再感知"回复完还在转"）。
      // setThreadSummary 是同步内存写 + 自身异步落库，算完即写入供下次 run 注入。
      const runText = buildRunText(steps, messages);
      if (runText.trim()) {
        const prev = getThreadSummary(threadId);
        void rollupThreadSummary(prev, runText, DEFAULT_POLICY)
          .then((rolled) => {
            setThreadSummary(threadId, rolled);
            logger.for("thread-memory").info("summary rolled", {
              thread: threadId,
              chars: rolled.length,
              prevChars: prev?.length ?? 0,
            });
          })
          .catch((err) =>
            logger.for("thread-memory").error("rollup failed", { err: (err as Error).message })
          );
      }

      try {
        await recordRun({
          threadId,
          runId,
          agentId,
          userId,
          steps: stepCount,
          promptTokens,
          completionTokens,
          durationMs: totalMs,
          finishReason: finishReason ?? null,
          model: model ?? null,
          intent: intent ?? null,
          status: finishReason === "error" ? "error" : "success",
        });
      } catch (err) {
        logger.for("Audit").error("recordRun failed", { err: (err as Error).message });
      }
    },
  };
}
