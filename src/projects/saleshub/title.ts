// 对话标题生成（中台统一装配）：首次对话结束时，用一次轻量模型调用概括一个对话标题。
// 供销售系统等接入项目使用：标题生成逻辑收拢在平台侧，前端/后端不各自拼凑。
// 做法：按 threadId 缓存"已生成过"标记（进程内有效），并回退到截断，确保永不阻断归档。
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { settings } from "../../config/settings.js";
import { logger } from "../../observe/logger.js";

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

const generatedTitles = new Set<string>();
const MAX_TITLE_LEN = 20;

function truncateTitle(userMessage: string, assistantReply: string): string {
  const source = (userMessage || assistantReply || "").replace(/\s+/g, " ").trim();
  if (!source) return "新对话";
  return source.length > MAX_TITLE_LEN ? source.substring(0, MAX_TITLE_LEN) + "…" : source;
}

/**
 * 生成对话标题。首次对话（threadId 未生成过）时触发；否则返回 null。
 * 单个 thread 只在当前进程生命周期内生成一次；会话标题写库由 saleshub 后端 ISNULL 兜底去重。
 */
export async function maybeGenerateTitle(
  threadId: string,
  userMessage: string,
  assistantReply: string,
): Promise<string | null> {
  if (generatedTitles.has(threadId)) return null;
  generatedTitles.add(threadId); // 先占位，避免并发重复触发

  const source = (userMessage || assistantReply || "").replace(/\s+/g, " ").trim();
  if (!source) return null;

  const t0 = Date.now();
  try {
    const { text } = await generateText({
      model: getRawModel(),
      system:
        "你是一个对话标题生成器。根据用户的第一句话和助手回答，用一句简短中文概括这段对话的主题。" +
        `只输出标题本身，不加引号、标点、编号或任何解释，长度控制在 ${MAX_TITLE_LEN} 字以内。`,
      prompt: `用户问：${userMessage}\n\n助手答：${assistantReply}\n\n请给这段对话起一个简短标题：`,
      temperature: 0.3,
      maxOutputTokens: 64,
    });
    const title = text.replace(/[""'「」【】\n\r]/g, "").trim().slice(0, MAX_TITLE_LEN);
    logger.for("title").info("generated title", {
      threadId,
      title,
      ms: Date.now() - t0,
    });
    return title || truncateTitle(userMessage, assistantReply);
  } catch (err) {
    logger.for("title").warn("fallback to truncation", {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return truncateTitle(userMessage, assistantReply);
  }
}
