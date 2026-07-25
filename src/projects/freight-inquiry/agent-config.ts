// Freight Inquiry - AgentConfig（多货代询价比价 + AI 解析/评估）
import type { AgentConfig } from '../../types/agent-config.js';
import { freightInquiryTools } from './tools/index.js';
import { buildFreightPrompt } from './prompts.js';

export const freightInquiryAgentConfig: AgentConfig = {
  agentId: 'freight_inquiry',
  description:
    '国际空运询比价系统（FSCargo）：多货代询价 → AI 解析报价邮件 → AI 偏好评估推荐 → 销售管理审核议价 → 确认。验证中台驱动"多角色协作 + AI 结构化提取"流程。',
  resolveContext: async ({ userId }) => ({
    userId,
    role: 'customer',
    name: '销售',
  }),
  tools: freightInquiryTools,
  buildSystemPrompt: ({ context }) => buildFreightPrompt(context),
};
