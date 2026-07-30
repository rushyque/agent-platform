// 工具聚合 —— 业务工具 + 中台通用工具（coreTools 显式取用）
import type { ToolDefinition } from '../../../types/agent-config.js';
import { coreTools } from '../../../core/tools/index.js';
import {
  createInquiryTool,
  setPreferenceTool,
  listForwardersTool,
  listInquiriesTool,
  viewInquiryTool,
} from './inquiry.js';
import { dispatchInquiryEmailsTool, collectQuoteEmailsTool, viewEmailsTool } from './email.js';
import { parseQuoteEmailsTool, evaluateQuotesTool } from './ai.js';
import {
  notifyManagerReviewTool,
  reviewQuotesTool,
  negotiateTool,
  recordDecisionTool,
  confirmForwarderTool,
} from './decision.js';
import { viewQuotesComparisonTool, viewRecommendationTool } from './views.js';

export const freightInquiryTools: ToolDefinition[] = [
  // 询价提交
  createInquiryTool,
  setPreferenceTool,
  listForwardersTool,
  listInquiriesTool,
  viewInquiryTool,
  // 邮件驱动
  dispatchInquiryEmailsTool,
  collectQuoteEmailsTool,
  viewEmailsTool,
  // AI 核心
  parseQuoteEmailsTool,
  evaluateQuotesTool,
  // 决策（含真审核回路）
  notifyManagerReviewTool,
  reviewQuotesTool,
  negotiateTool,
  recordDecisionTool,
  confirmForwarderTool,
  // 视图
  viewQuotesComparisonTool,
  viewRecommendationTool,
  // 中台通用工具（observe_state 需要 resolveContext 的 getState，已注入；其余零接线）
  coreTools.observeState,
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];
