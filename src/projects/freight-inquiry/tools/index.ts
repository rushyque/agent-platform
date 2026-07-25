// 工具聚合 —— 共 16 个工具，按流程分组
import type { ToolDefinition } from '../../../types/agent-config.js';
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
  // 决策
  notifyManagerReviewTool,
  negotiateTool,
  recordDecisionTool,
  confirmForwarderTool,
  // 视图
  viewQuotesComparisonTool,
  viewRecommendationTool,
];
