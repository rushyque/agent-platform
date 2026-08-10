import type { StopCondition } from "ai";

// 通用循环止损 —— 所有走 Hermes 多步循环的 agent 共用。
// 作为 streamText 的 stopWhen 注入：除了步数硬上限外，检测"同一工具调用"与
// "同一段助手文本"的重复，一旦命中判定模型卡住，提前终止循环，避免像
// "工具缺参→反复重试同一查询"这类问题无限刷屏烧 token。
export interface LoopGuardOptions {
  /** 步数硬上限（默认 30，等价原先的 stepCountIs(30)） */
  maxSteps?: number;
  /** 相同工具签名（工具名+参数）出现 >= 此次数即判定卡住（默认 3） */
  maxRepeatedToolCall?: number;
  /** 相同助手文本出现 >= 此次数即判定卡住（默认 3） */
  maxRepeatedText?: number;
  /** 触发文本判定的最短文本长度，避免短客套语（如"好的，我来查"）误伤（默认 16） */
  minRepeatedTextLength?: number;
  /** 不参与工具重复判定的工具名（默认空） */
  ignoreTools?: string[];
}

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function toolSignature(tc: any): string {
  const name: string = tc?.toolName ?? "";
  let args: unknown = tc?.args ?? tc?.input;
  if (args == null) args = {};
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return `${name}|${s}`;
}

export function createLoopGuard(opts?: LoopGuardOptions): StopCondition<any> {
  const maxSteps = opts?.maxSteps ?? 30;
  const maxRepeatedToolCall = opts?.maxRepeatedToolCall ?? 3;
  const maxRepeatedText = opts?.maxRepeatedText ?? 3;
  const minRepeatedTextLength = opts?.minRepeatedTextLength ?? 16;
  const ignoreTools = new Set(opts?.ignoreTools ?? []);

  return ({ steps }) => {
    if (steps.length >= maxSteps) return true;

    if (maxRepeatedToolCall > 0) {
      const counts = new Map<string, number>();
      for (const step of steps) {
        for (const tc of step.toolCalls ?? []) {
          const name: string = tc?.toolName ?? "";
          if (ignoreTools.has(name)) continue;
          const sig = toolSignature(tc);
          const n = (counts.get(sig) ?? 0) + 1;
          if (n >= maxRepeatedToolCall) return true;
          counts.set(sig, n);
        }
      }
    }

    if (maxRepeatedText > 0) {
      const counts = new Map<string, number>();
      for (const step of steps) {
        const t = normalizeText(step?.text ?? "");
        if (!t || t.length < minRepeatedTextLength) continue;
        const n = (counts.get(t) ?? 0) + 1;
        if (n >= maxRepeatedText) return true;
        counts.set(t, n);
      }
    }

    return false;
  };
}
