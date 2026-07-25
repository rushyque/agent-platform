// 邮件驱动组（系统/货代，半模拟）
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { dispatchInquiryEmails, collectQuoteEmails } from '../engine.js';
import { getWorld } from '../state.js';

export const dispatchInquiryEmailsTool: ToolDefinition = {
  name: 'dispatch_inquiry_emails',
  description: '系统向匹配的预设货代批量发送询价邮件。询价状态 draft → sent。区域专精货代只接专长航线。',
  parameters: z.object({ inquiryId: z.string().describe('询价单 ID') }),
  execute: async (args, context) => {
    const res = dispatchInquiryEmails(context.userId, args.inquiryId);
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    return {
      ok: true,
      message: res.message,
      dispatchedTo: (res.data as any[]).map((e) => e.to),
      hint: '下一步：collect_quote_emails 收集各家报价。',
    };
  },
};

export const collectQuoteEmailsTool: ToolDefinition = {
  name: 'collect_quote_emails',
  description: '收集各家货代的报价回复邮件（半模拟：按各家风格生成自然语言正文，含运费/附加费/航司/时效/有效期）。状态 sent → quoting。',
  parameters: z.object({ inquiryId: z.string().describe('询价单 ID') }),
  execute: async (args, context) => {
    const res = collectQuoteEmails(context.userId, args.inquiryId);
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    return {
      ok: true,
      message: res.message,
      count: res.data.length,
      fromForwarders: res.data.map((q) => ({
        forwarderId: q.truthQuote?.forwarderId,
        forwarderName: q.truthQuote?.forwarderName,
      })),
      hint: '报价邮件已入库。下一步：parse_quote_emails 让 AI 提取结构化数据。',
    };
  },
};

export const viewEmailsTool: ToolDefinition = {
  name: 'view_emails',
  description: '查看某询价单的邮件列表（询价/报价/议价/通知），可选过滤类型。',
  parameters: z.object({
    inquiryId: z.string().describe('询价单 ID'),
    kind: z
      .enum(['inquiry_outbound', 'quote_inbound', 'negotiation_inbound', 'review_notice', 'confirm_notice'])
      .optional()
      .describe('邮件类型过滤'),
  }),
  execute: async (args, context) => {
    const world = getWorld(context.userId);
    const list = world.emails.filter((e) => e.inquiryId === args.inquiryId && (!args.kind || e.kind === args.kind));
    return {
      count: list.length,
      emails: list.map((e) => ({
        id: e.id,
        kind: e.kind,
        from: e.from,
        to: e.to,
        subject: e.subject,
        receivedAt: e.receivedAt,
        parsed: !!(e as any).parsedQuote,
      })),
    };
  },
};
