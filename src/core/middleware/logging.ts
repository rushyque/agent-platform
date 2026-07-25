import { recordRun } from "../../persistence/run-store.js";
import {
  getThreadSummary,
  setThreadSummary,
  rollupThreadSummary,
  DEFAULT_POLICY,
} from "../context/index.js";

// 审计 + token 计费 + 线程滚动摘要钩子。
// onStepFinish 记每步；onFinish 记总览（agent_runs，DB 挂降级）并把本次对话压进 thread_summary，
// 作为下次 run 注入 system 的延续上下文。原始历史不保留。

export interface RunHooksParams {
  agentId: string;
  userId: string | null;
  threadId: string;
  runId: string;
  messages?: any[];
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
  const { agentId, userId, threadId, runId, messages } = params;
  const startedAt = Date.now();

  return {
    onStepFinish: ({ text, toolCalls, toolResults, usage, finishReason }: any) => {
      const elapsed = Date.now() - startedAt;
      const toolSummary =
        toolCalls && toolCalls.length > 0
          ? toolCalls.map((tc: any) => tc.toolName).join(",")
          : "none";
      const tokens = usage
        ? `prompt=${usage.promptTokens ?? 0} completion=${usage.completionTokens ?? 0}`
        : "n/a";
      console.log(
        `[Audit] agent=${agentId} thread=${threadId} step@+${elapsed}ms: finishReason=${finishReason} tools=[${toolSummary}] tokens(${tokens}) textLen=${text?.length ?? 0}`
      );
    },

    onFinish: async ({ steps, usage, finishReason }: any) => {
      const stepCount = Array.isArray(steps) ? steps.length : 0;
      const promptTokens = usage?.promptTokens ?? null;
      const completionTokens = usage?.completionTokens ?? null;
      const totalMs = Date.now() - startedAt;
      console.log(
        `[Audit] agent=${agentId} thread=${threadId} run DONE in ${totalMs}ms: steps=${stepCount} finishReason=${finishReason} prompt=${promptTokens ?? "n/a"} completion=${completionTokens ?? "n/a"}`
      );

      // 线程滚动摘要：上次摘要 + 本次对话 → 新单段，覆写存内存，下次 run 注入 system
      try {
        const runText = buildRunText(steps, messages);
        if (runText.trim()) {
          const prev = getThreadSummary(threadId);
          const rolled = await rollupThreadSummary(prev, runText, DEFAULT_POLICY);
          setThreadSummary(threadId, rolled);
          console.log(
            `[thread-memory] ${threadId} summary rolled: ${rolled.length}chars (prev ${prev?.length ?? 0})`
          );
        }
      } catch (err) {
        console.error(`[thread-memory] rollup failed:`, (err as Error).message);
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
          status: finishReason === "error" ? "error" : "success",
        });
      } catch (err) {
        console.error(`[Audit] recordRun failed:`, (err as Error).message);
      }
    },
  };
}
