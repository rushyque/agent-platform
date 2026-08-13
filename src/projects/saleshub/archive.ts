// 对话历史整轮归档：中台 run 完成后，把本轮用户问答 + 工具调用轨迹一次性写入
// SalesHub 后端（项目侧结构化历史表 chat_sessions / chat_messages / chat_tool_calls）。
// 用用户原始 JWT 调 {apiBase}/api/chats/archive，SalesHub 后端按 token 归属用户落库。
import type { SalesContext } from "./tools/helpers.js";
import { logger } from "../../observe/logger.js";
import { maybeGenerateTitle } from "./title.js";

interface ToolCallArg {
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
}

interface ToolResultArg {
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

interface Step {
  text?: string;
  toolCalls?: ToolCallArg[];
  toolResults?: ToolResultArg[];
}

function stringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 用户侧对话历史归档。由 createRunHooks.onFinish 回调触发（fire-and-forget）。
 */
export async function archiveRun(
  ctx: SalesContext,
  threadId: string,
  runId: string,
  steps: Step[],
  userMessages?: any[],
): Promise<void> {
  const messages: Array<{
    role: string;
    content: string;
    final_answer?: string;
    render_components?: string;
  }> = [];

  // 本轮用户消息（含选择交接标记的归一化内容）
  for (const m of Array.isArray(userMessages) ? userMessages : []) {
    if (m?.role !== "user") continue;
    let content = typeof m?.content === "string" ? m.content : stringify(m?.content) || "";
    // 取最终纯文本，去掉内部的 choice 交接噪音可选；保留原文即可，前端可展示。
    messages.push({ role: "user", content });
  }

  // assistant 输出：按步骤累积正文 + 从 steps 提取最终答案落库
  let assistantText = "";
  for (const step of Array.isArray(steps) ? steps : []) {
    if (typeof step?.text === "string" && step.text.trim()) assistantText += step.text;
  }
  if (assistantText.trim()) {
    const finalAnswer = extractFinalAnswer(assistantText);
    messages.push({
      role: "assistant",
      content: assistantText,
      final_answer: finalAnswer,
      render_components: extractRenderComponents(assistantText),
    });
  }

  // 工具调用轨迹（去重：同一 toolCallId 只记一次结果）
  const toolCalls: Array<{
    step_order: number;
    tool_name: string;
    tool_args?: string;
    tool_result?: string;
  }> = [];
  const seenResults = new Set<string>();
  let order = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    const calls = step?.toolCalls || [];
    for (const tc of calls) {
      const key = tc.toolCallId || `${tc.toolName}-${order}-${stringify(tc.args) || ""}`;
      // 结果在同一步骤 toolResults 里
      const match = (step.toolResults || []).find(
        (tr) => tr.toolName === tc.toolName && !seenResults.has(`${tc.toolName}::${JSON.stringify(tr.args)}`),
      );
      const result = match ? stringify(match.result) : undefined;
      if (match) seenResults.add(`${tc.toolName}::${JSON.stringify(match.args)}`);
      if (tc.toolName === "getArtifact" || tc.toolName === "recall") {
        // 平台内部工具不归档到用户历史
        continue;
      }
      toolCalls.push({
        step_order: order++,
        tool_name: tc.toolName || "",
        tool_args: stringify(tc.args),
        tool_result: result,
      });
    }
  }

  if (messages.length === 0) return;

  // 首次对话：用轻量模型概括一个标题（中台统一装配；失败回退截断，不阻断归档）。
  const userText = messages.find((m) => m.role === "user")?.content?.toString() || "";
  const assistantReplyText =
    messages.find((m) => m.role === "assistant")?.content?.toString() || "";
  const generatedTitle = await maybeGenerateTitle(threadId, userText, assistantReplyText);

  const payload = {
    session_id: threadId,
    run_id: runId,
    title: generatedTitle ?? undefined,
    messages,
    tool_calls: toolCalls,
  };

  try {
    const resp = await fetch(`${ctx.apiBase}/api/chats/archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      logger.for("archive").warn("archive response not ok", {
        status: resp.status,
        threadId,
      });
    } else {
      logger.for("archive").info("archived run", {
        threadId,
        runId,
        messages: messages.length,
        tools: toolCalls.length,
      });
    }
  } catch (err) {
    logger.for("archive").error("archive failed", { err: (err as Error).message });
  }
}

function extractFinalAnswer(content: string): string | undefined {
  const match = content.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
  return match && match[1] ? match[1].trim() : undefined;
}

function extractRenderComponents(content: string): string | undefined {
  const blocks: unknown[] = [];
  const re = /<render>\s*(\[[\s\S]*?\])\s*<\/render>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) blocks.push(...parsed);
    } catch {
      // 忽略不可解析的 render 片段
    }
  }
  return blocks.length > 0 ? JSON.stringify(blocks) : undefined;
}
