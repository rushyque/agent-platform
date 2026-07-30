// Freight Inquiry - AgentConfig（多货代询价比价 + AI 解析/评估）
import type { AgentConfig } from '../../types/agent-config.js';
import { freightInquiryTools } from './tools/index.js';
import { buildFreightPrompt } from './prompts.js';
import { freightStateSummary } from './observe-state.js';

export const freightInquiryAgentConfig: AgentConfig = {
  agentId: 'freight_inquiry',
  description:
    '国际空运询比价系统（FSCargo）：多货代询价 → AI 解析报价邮件 → AI 偏好评估推荐 → 销售管理审核议价 → 确认。验证中台驱动"多角色协作 + AI 结构化提取"流程。',
  resolveContext: async ({ userId }) => ({
    userId,
    role: 'customer',
    name: '销售',
    // 供 coreTools.observeState 调用：看全局现状（阶段/下一步/待审核），治 4 个 view 工具各看一片。
    getState: (ctx: any, focus?: string) => freightStateSummary(ctx.userId, focus),
  }),
  tools: freightInquiryTools,
  buildSystemPrompt: ({ context }) => buildFreightPrompt(context),
};
