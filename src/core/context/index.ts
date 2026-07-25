// 上下文管理模块：压缩 / 折叠 / 摘要 / 工具结果外置。
// 设计目标：对抗 DeepSeek 多步工具调用后的 context 膨胀与幻觉。
// 接入点：createLLMClient 挂 compactionMiddleware（每次模型调用前压缩）+
//         server.toAISDKTools / dag-executor.executeToolStep 外置工具结果。
export { compactPrompt, compactionMiddleware } from "./compactor.js";
export { DEFAULT_POLICY } from "./policy.js";
export type { CompactionPolicy } from "./policy.js";
export { foldToolResult, entryToText, estimateChars } from "./folder.js";
export { summarizePromptEntries, rollupThreadSummary } from "./summarizer.js";
export { getThreadSummary, setThreadSummary } from "./thread-memory.js";
