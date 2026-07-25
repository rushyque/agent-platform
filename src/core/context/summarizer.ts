import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { settings } from "../../config/settings.js";
import type { CompactionPolicy } from "./policy.js";
import { entryToText } from "./folder.js";

// 摘要底层：把任意文本压成单段事实摘要。覆写式（输出恒为一段，不累积）。
// 用纯净 model（不挂压缩 middleware），避免 transformParams 递归。带 hash 缓存：相同输入复用结果。

let rawModelCache: any = null;
function getRawModel(): any {
  if (!rawModelCache) {
    const openai = createOpenAI({
      apiKey: settings.DEEPSEEK_API_KEY,
      baseURL: settings.DEEPSEEK_BASE_URL,
    });
    rawModelCache = (openai as any).chat(settings.DEEPSEEK_MODEL);
  }
  return rawModelCache;
}

const summaryCache = new Map<string, string>();
const SUMMARY_CACHE_MAX = 500;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function summarizeText(text: string, policy: CompactionPolicy): Promise<string> {
  if (!text.trim()) return "";
  const key = hash(text);
  const hit = summaryCache.get(key);
  if (hit) {
    console.log(`[summarize] cache hit out=${hit.length}chars`);
    return hit;
  }

  const t0 = Date.now();
  let summary = "";
  try {
    const { text: out } = await generateText({
      model: getRawModel(),
      system:
        "你是上下文压缩器。把下面的记录压成一段紧凑事实摘要，只保留对后续任务有用的内容：" +
        "已做的事、关键数据/ID、已确定的结论、用户目标与硬约束。丢弃过程噪声与原文复述。" +
        "输出纯文本一段，不要标题或列表。",
      prompt: `压缩到约 ${policy.summaryBudgetChars} 字以内：\n\n` + text.slice(0, 8000),
    });
    summary = out.trim().slice(0, policy.summaryBudgetChars);
    console.log(`[summarize] ${text.length}→${summary.length} chars ${Date.now() - t0}ms`);
  } catch (err) {
    console.error("[summarize] failed, fallback to truncation:", (err as Error).message);
    summary = text.slice(0, policy.summaryBudgetChars);
  }

  if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    const first = summaryCache.keys().next().value;
    if (first) summaryCache.delete(first);
  }
  summaryCache.set(key, summary);
  return summary;
}

// 压缩一组 prompt entries（compactor 的 token 兜底用）
export async function summarizePromptEntries(
  entries: any[],
  policy: CompactionPolicy
): Promise<string> {
  return summarizeText(entries.map(entryToText).join("\n"), policy);
}

// 线程滚动摘要：把"上次摘要 + 本次对话文本"压成新的单段（覆写旧摘要）。
export async function rollupThreadSummary(
  prevSummary: string | null,
  runText: string,
  policy: CompactionPolicy
): Promise<string> {
  const full =
    (prevSummary ? `[上一阶段摘要]\n${prevSummary}\n\n` : "") + `[本次对话]\n${runText}`;
  return summarizeText(full, policy);
}
