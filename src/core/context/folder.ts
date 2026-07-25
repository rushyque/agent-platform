import type { CompactionPolicy } from "./policy.js";
import { summarizeToolResult } from "./artifact-store.js";

// AI SDK v5 prompt 结构：entry = { role, content: [{type, ...}] }。
// tool-result 是 content 里的 part（不是顶层 entry）。entryToText/partToText 据此遍历。

// 把单个 entry 转可读短文本：用于长度估算与摘要输入。
export function entryToText(entry: any): string {
  const parts = Array.isArray(entry?.content) ? entry.content : null;
  if (parts) {
    const role = entry?.role ?? entry?.type ?? "?";
    return `[${role}] ${parts.map(partToText).join(" ")}`;
  }
  // 兼容旧扁平格式 fallback
  switch (entry?.type) {
    case "system":
      return `[system] ${entry.text ?? ""}`;
    case "text":
      return `[${entry.role ?? "user"}] ${entry.content ?? ""}`;
    default:
      return safeStr(entry?.text ?? entry?.content ?? entry);
  }
}

function partToText(p: any): string {
  switch (p?.type) {
    case "text":
      return p.text ?? "";
    case "tool-call":
      return `[tool-call ${p.toolName}] ${safeStr(p.input)}`;
    case "tool-result":
      return `[tool-result ${p.toolName}] ${typeof p.output === "string" ? p.output : safeStr(p.output)}`;
    default:
      return safeStr(p);
  }
}

function safeStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function tryParse(v: unknown): any {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// 折叠一个 tool-result 的 output 为精简占位文本。
// 调用方保留 part 结构（v5 要求 tool-call/tool-result 配对），仅替换 output。
// output 可能是 execute 外置后的 {ref,toolName,summary} 串，或原始 result（兼容未外置/DB 降级）。
export function foldToolResult(rawOutput: unknown, policy: CompactionPolicy): string {
  const parsed = tryParse(rawOutput);
  let ref: string | null = null;
  let toolName = "tool";
  let summary: string;
  if (parsed && typeof parsed === "object" && typeof parsed.ref === "string") {
    ref = parsed.ref;
    toolName = parsed.toolName ?? toolName;
    summary = summarizeToolResult(parsed.summary ?? parsed.result ?? parsed, policy.foldedSummaryChars);
  } else {
    summary = summarizeToolResult(rawOutput, policy.foldedSummaryChars);
  }
  if (ref && policy.foldHintStyle !== "silent") {
    return `[已折叠 ${toolName} ref=${ref} | 需要完整数据时调用 getArtifact] ${summary}`;
  }
  // silent 或无 ref：不暴露 ref、不提示 getArtifact，避免模型瞎编 ref 反复调用失败。
  // 模型需要细节时改走重调原工具（更可靠）。
  return `[已折叠 ${toolName} | ${summary}]`;
}

export function estimateChars(prompt: any[]): number {
  let n = 0;
  for (const e of prompt) n += entryToText(e).length;
  return n;
}
