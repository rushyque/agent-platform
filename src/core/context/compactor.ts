import { DEFAULT_POLICY, type CompactionPolicy } from "./policy.js";
import { entryToText, foldToolResult, estimateChars } from "./folder.js";
import { summarizePromptEntries } from "./summarizer.js";
import { logger } from "../../observe/logger.js";

// 主压缩入口：被 compactionMiddleware.transformParams 在每次模型调用前调用，
// 覆盖 Hermes 模式 AI SDK 多步循环的每一步 + 每轮进入时的历史。无状态（除 summarizer 内部缓存）。
//
// 适配 AI SDK v5 prompt：entry = { role, content: [{type, ...}] }，tool-result 是 content 里的 part。
export async function compactPrompt(
  prompt: any[],
  policy: CompactionPolicy = DEFAULT_POLICY,
  readonlyTools?: Set<string>
): Promise<any[]> {
  if (!Array.isArray(prompt) || prompt.length === 0) return prompt;

  // 只读工具结果不进入折叠候选（始终完整保留），断"折叠→重查→再折叠"循环。
  // 判定优先级：① 工具显式声明 readonly（per-run 传入，可靠，治"起错名致折叠死循环"）
  //            ② 工具名包含关键词（兜底，大小写不敏感，覆盖 view/list/detail 等命名）
  const isReadOnly = (part: any) => {
    const name = (part?.toolName ?? "").toLowerCase();
    if (readonlyTools?.has(name)) return true;
    return policy.readOnlyToolKeywords.some((k) => name.includes(k));
  };

  // 收集【可折叠】tool-result part 的位置 (entryIdx, partIdx) —— 排除只读工具
  const trLocs: Array<{ ei: number; pi: number }> = [];
  prompt.forEach((e: any, ei: number) => {
    const parts = Array.isArray(e?.content) ? e.content : [];
    parts.forEach((p: any, pi: number) => {
      if (p?.type === "tool-result" && !isReadOnly(p)) trLocs.push({ ei, pi });
    });
  });

  const hotCount = Math.min(policy.hotToolResults, trLocs.length);

  // 快速通道：可折叠 tool-result 在热窗口内、整体不超预算 → 零改动 passthrough（简单对话零开销）
  if (trLocs.length <= hotCount && estimateChars(prompt) <= policy.maxPromptChars) {
    return prompt;
  }

  // 折叠老 tool-result（除最后 hotCount 个）：仅替换 part.output，保留 entry/part 结构
  // （维持 tool-call/tool-result 配对，否则 OpenAI/DeepSeek 会 400）。
  const foldCount = trLocs.length - hotCount;
  const foldSet = new Set(trLocs.slice(0, foldCount).map((l) => `${l.ei}:${l.pi}`));

  const result = prompt.map((e: any, ei: number) => {
    if (!Array.isArray(e?.content)) return e;
    const hasFold = e.content.some((_: any, pi: number) => foldSet.has(`${ei}:${pi}`));
    if (!hasFold) return e;
    return {
      ...e,
      content: e.content.map((p: any, pi: number) =>
        p?.type === "tool-result" && foldSet.has(`${ei}:${pi}`)
          ? { ...p, output: foldToolResult(p.output, policy) }
          : p
      ),
    };
  });

  // token 兜底：折叠后仍超上限 → 把中段超长区段摘要成单段 system 注入
  if (estimateChars(result) > policy.maxPromptChars) {
    return await shrinkOldSection(result, policy);
  }
  return result;
}

// 把 prompt 中段（system 之后、末尾热区之前）超长的部分摘要成单段 system。
async function shrinkOldSection(
  entries: any[],
  policy: CompactionPolicy
): Promise<any[]> {
  const isSystem = (e: any) => e?.role === "system" || e?.type === "system";
  const systemEntries = entries.filter(isSystem);
  const rest = entries.filter((e) => !isSystem(e));

  const keepTail = policy.keepRecentUserMessages * 4 + policy.hotToolResults * 2 + 2;
  if (rest.length <= keepTail) return entries;

  const adjustedOld = rest.slice(0, rest.length - keepTail);
  const adjustedTail = rest.slice(rest.length - keepTail);

  // 修正切点：old 末 entry 含 tool-call、tail 首 entry 含 tool-result 时，把 old 末移入 tail
  // （维持 tool-call/tool-result 配对，否则 API 400）
  while (adjustedOld.length > 0) {
    const last = adjustedOld[adjustedOld.length - 1];
    const first = adjustedTail[0];
    const lastHasTC =
      Array.isArray(last?.content) && last.content.some((p: any) => p?.type === "tool-call");
    const firstHasTR =
      Array.isArray(first?.content) && first.content.some((p: any) => p?.type === "tool-result");
    if (lastHasTC && firstHasTR) adjustedTail.unshift(adjustedOld.pop()!);
    else break;
  }

  const oldChars = adjustedOld.reduce((n, e) => n + entryToText(e).length, 0);
  if (oldChars < policy.summarizeThresholdChars) {
    return entries;
  }

  const summary = await summarizePromptEntries(adjustedOld, policy);
  const summaryEntry = {
    role: "system",
    content: [{ type: "text", text: `[历史摘要] ${summary}` }],
  };
  return [...systemEntries, summaryEntry, ...adjustedTail];
}

// AI SDK LanguageModelMiddleware：在每次 doStream/doGenerate 前（含 Hermes 多步循环内部每一步）
// 压缩 params.prompt。与 deepseekReasoningMiddleware 一起挂在 createLLMClient 上。
//
// 工厂形式：每次 run 创建 client 时，把该 run 激活的"只读工具名集合"闭包进来，
// 让 compactPrompt 能按 ToolDefinition.readonly 声明判定只读（不靠 ALS——streamText
// 惰性迭代下 ALS 续体不可靠，见 observe/als.ts 注释）。
export function createCompactionMiddleware(opts?: { readonlyTools?: Set<string> }) {
  const readonlyTools = opts?.readonlyTools
    ? new Set([...opts.readonlyTools].map((n) => n.toLowerCase()))
    : undefined;
  return {
    middlewareVersion: "v2" as const,
    transformParams: async ({ params }: any) => {
      const t0 = Date.now();
      try {
        const before = estimateChars(params?.prompt);
        const compacted = await compactPrompt(params.prompt, DEFAULT_POLICY, readonlyTools);
        const after = estimateChars(compacted);
        logger.for("compact").info("compacted", { before, after, saved: before - after, ms: Date.now() - t0 });
        return { ...params, prompt: compacted };
      } catch (err) {
        logger.for("compactor").error("transformParams failed, passthrough", { err: (err as Error).message });
        return params;
      }
    },
  };
}

// 默认实例：无 per-run 只读映射时用（nl2sql/extract 等内部 generateObject 调用）。
export const compactionMiddleware = createCompactionMiddleware();
