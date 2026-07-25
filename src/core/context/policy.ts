// 上下文压缩策略 —— 中台内置默认，所有项目共用。
// 设计依据：DeepSeek 对长 context 注意力脆弱，多步工具调用后易幻觉。
//
// 历史：初版 K=1 激进折叠在 DeepSeek 上触发"折叠→重查→再折叠"死循环
// （baseline 实测 B 用例 49 次调用、19 次 getArtifact、跑满 30 步被强制截断），
// 是幻觉放大器而非治本。
// 2026-07-25 修复（G4'，A/B 验证）：只读工具结果不折叠 + silent 折叠（不暴露 ref）
//   → 同用例降至 ~10 次、0 getArtifact、汇报数字准确（不再碎片拼凑）。
export interface CompactionPolicy {
  // 保留最近 K 个【非只读】tool-result 完整（含当前步正在观察的）。其余折叠为占位。
  hotToolResults: number;
  // 只读工具结果始终完整保留，不进入折叠候选。按"工具名包含关键词"判断（大小写不敏感）。
  // 依据：DeepSeek 看到只读结果被折叠会反复重查；保留完整切断循环。
  // 默认 view/list/detail 覆盖常见只读命名（factory_view_*, list_orders, order_detail 等）。
  readOnlyToolKeywords: string[];
  // 折叠占位是否提示"调用 getArtifact"。
  // silent：不暴露 ref、不提示取回，模型需细节时重调原工具（比 getArtifact 可靠，不会编造 ref）。
  foldHintStyle: "getArtifact" | "silent";
  // 保留最近 N 条 user 消息完整（用户意图锚点，始终保留）。
  keepRecentUserMessages: number;
  // 压缩后整个 prompt 的字符上限（token 粗估：中文约 1 字≈1 token）。超出则触发摘要兜底。
  maxPromptChars: number;
  // execute 外置时，模型首次观察到的 summary 字符上限。
  toolResultSummaryChars: number;
  // tool-result 滑出热窗口后，折叠占位里 summary 的字符上限（比首次更短）。
  foldedSummaryChars: number;
  // 窗口外旧内容字符超过此值才触发模型摘要；否则纯规则折叠即可（省一次模型调用）。
  summarizeThresholdChars: number;
  // 摘要产物字符上限（覆写式：每次只产出这一段，不累积成多段）。
  summaryBudgetChars: number;
}

export const DEFAULT_POLICY: CompactionPolicy = {
  hotToolResults: 1,
  readOnlyToolKeywords: ["view", "list", "detail"],
  foldHintStyle: "silent",
  keepRecentUserMessages: 2,
  maxPromptChars: 18000,
  toolResultSummaryChars: 200,
  foldedSummaryChars: 80,
  summarizeThresholdChars: 2000,
  summaryBudgetChars: 600,
};
