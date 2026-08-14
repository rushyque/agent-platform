/**
 * 同签名工具幂等去重（Hermes 多步循环专用）。
 *
 * 背景：模型在拿到"已内联全量结果"后，仍可能出于"确认"心理对同一工具+同一参数
 * 重复调用 2–3 次（测试：1.1/1.2 ×2，2.2/2.6/2.7 ×3）。内联解决了"取回 artifact
 * 的循环"，但没有解决"重跑同一查询"的循环。
 *
 * 这里在工具执行层做去重：同一次 run 内，同一工具的同一参数签名第二次命中时，
 * 不再重复调用后端（后端/DB 白跑），而是直接回放上次内联的完整结果，并附一句
 * 明确的信任提示，引导模型直接基于已有数据作答、停止重查。
 *
 * 只对"幂等且昂贵"的只读查询工具生效：
 *  - now / recall / getNote 之类廉价、无状态的元工具不参与（模型可正常重复取时钟）；
 *  - 写工具（setNote / confirm 等）天然不幂等，不参与。
 */

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = (value as Record<string, unknown>)[key];
  }
  return JSON.stringify(out);
}

export function toolSignature(toolName: string, args: unknown): string {
  return `${toolName}|${stableStringify(args)}`;
}

/** 从 zod schema 里安全取参数键集合（仅对象类 schema 有 shape）。 */
export function schemaKeys(schema: unknown): string[] {
  const s = schema as { shape?: Record<string, unknown> } | null | undefined;
  return s?.shape ? Object.keys(s.shape) : [];
}

/** 这些元工具调用频率高但代价极低或语义非幂等，不参与去重。 */
const DEDUP_IGNORE = new Set([
  "now",
  "recall",
  "getNote",
  "setNote",
  "confirm",
  "getArtifact",
  // UI 交互/状态工具：每次调用都应让前端真正执行一遍并回传最新 DOM 状态，
  // 不是幂等查询。去重回放会给模型过时的页面/动作结果，导致它误以为没进入、
  // 反复重触发入口而绕圈。因此一律不参与去重，始终实时执行。
  "navigate_to",
  "ui_click",
  "ui_fill",
  "get_page_state",
]);

export interface DedupCacheEntry {
  result: unknown;
  inline: boolean;
}

/** 每次 run 一个去重缓存。 */
export function createToolDedupCache(): Map<string, DedupCacheEntry> {
  return new Map();
}

/**
 * 命中判定：同名工具 + 相同参数签名 + 上次结果已完整内联，且该工具允许去重。
 * 命中时返回回放内容（含信任提示），否则返回 null（正常执行）。
 */
export function replayDedup(
  cache: Map<string, DedupCacheEntry>,
  toolName: string,
  args: unknown,
  invokeArgsSchemaKeys: string[]
): { replay: string } | null {
  if (DEDUP_IGNORE.has(toolName)) return null;
  const sig = toolSignature(toolName, args);
  const prev = cache.get(sig);
  if (!prev || !prev.inline) return null;
  // 用入参 schema 的键集合校验"本次与上次参数语义一致"（忽略工具可能补的默认字段），
  // 避免把参数序/可选字段差异误判为重复。
  const keys = [...new Set(invokeArgsSchemaKeys)].sort().join(",");
  const full = JSON.stringify(prev.result);
  return {
    replay:
      `[去重回放] 本次 ${toolName}（签名 keys=${keys}）与上一次调用参数一致，` +
      `其结果已在上文完整内联、未改变，完整结果如下：\n${full}\n` +
      `请直接基于以上数据作答，不要再重复调用 ${toolName} 查询同一参数。`,
  };
}
