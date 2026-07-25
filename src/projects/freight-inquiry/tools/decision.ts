// 决策组（销售管理动作）
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import {
  notifyManagerReview,
  negotiate,
  applyNegotiationToParsed,
  recordDecision,
  confirmForwarder,
} from '../engine.js';
import { getWorld } from '../state.js';
import { parseQuoteEmailsWithLLM } from '../llm-helpers.js';

export const notifyManagerReviewTool: ToolDefinition = {
  name: 'notify_manager_review',
  description: '系统向销售管理发送审核通知邮件（含 AI 推荐摘要），请其登录审核决策。',
  parameters: z.object({
    inquiryId: z.string(),
    managerEmail: z.string().optional().describe('销售管理邮箱，缺省 manager@fscargo.com'),
  }),
  execute: async (args, context) => {
    const res = notifyManagerReview(context.userId, args.inquiryId, args.managerEmail ?? 'manager@fscargo.com');
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    return {
      ok: true,
      message: res.message,
      email: { to: res.data.to, subject: res.data.subject },
      hint: '销售管理可查看报价对比表与 AI 推荐，决策后 record_decision。',
    };
  },
};

export const negotiateTool: ToolDefinition = {
  name: 'negotiate_with_forwarder',
  description: '销售管理与某货代议价（抄送 AI 邮箱）。系统生成货代议价回复邮件，AI 自动解析新报价并更新对应报价信息。',
  parameters: z.object({
    inquiryId: z.string(),
    forwarderId: z.string().describe('货代 ID，如 fy_lingyun'),
    targetUnitPrice: z.number().describe('议价目标单价 元/kg'),
  }),
  execute: async (args, context) => {
    const res = negotiate(context.userId, args.inquiryId, args.forwarderId, args.targetUnitPrice);
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    const negoEmail = res.data;

    // AI 解析议价邮件（验证解析能力）
    const world = getWorld(context.userId);
    const { parsed, trace } = await parseQuoteEmailsWithLLM([negoEmail], world.forwarders);
    // 用最新真值同步到 parsedQuote（保证后续评估用准值）
    applyNegotiationToParsed(context.userId, args.inquiryId, args.forwarderId);

    return {
      ok: true,
      message: res.message,
      negotiation: {
        forwarderName: negoEmail.truthQuote?.forwarderName,
        finalUnitPrice: negoEmail.truthQuote?.unitPrice,
        freightTotal: negoEmail.truthQuote?.freightTotal,
        aiParsed: parsed[0] ? { unitPrice: parsed[0].unitPrice, freightTotal: parsed[0].freightTotal } : null,
      },
      trace,
      hint: '报价已更新。可再次 evaluate_quotes 看新推荐。',
    };
  },
};

export const recordDecisionTool: ToolDefinition = {
  name: 'record_decision',
  description: '销售管理记录最终选择（选定货代 + 理由）。状态 → decided。',
  parameters: z.object({
    inquiryId: z.string(),
    forwarderId: z.string(),
    reason: z.string().describe('选择理由'),
  }),
  execute: async (args, context) => {
    const res = recordDecision(context.userId, args.inquiryId, args.forwarderId, args.reason);
    return res.ok ? { ok: true, message: res.message, hint: '下一步：confirm_forwarder 发送订舱确认。' } : { ok: false, message: res.message };
  },
};

export const confirmForwarderTool: ToolDefinition = {
  name: 'confirm_forwarder',
  description: '系统自动向选中的货代公司发送订舱确认通知。状态 decided → confirmed。',
  parameters: z.object({ inquiryId: z.string() }),
  execute: async (args, context) => {
    const res = confirmForwarder(context.userId, args.inquiryId);
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    return {
      ok: true,
      message: res.message,
      email: { to: res.data.to, subject: res.data.subject },
    };
  },
};
