// 视图组：报价对比表 / AI 推荐
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { getWorld } from '../state.js';
import type { QuoteEmail } from '../types.js';

export const viewQuotesComparisonTool: ToolDefinition = {
  name: 'view_quotes_comparison',
  description: '查看某询价单的报价对比表（各家运费/单价/附加费/时效/航司）。基于 AI 解析结果。',
  parameters: z.object({ inquiryId: z.string() }),
  execute: async (args, context) => {
    const world = getWorld(context.userId);
    const emails = world.emails.filter(
      (e) => e.inquiryId === args.inquiryId && e.kind === 'quote_inbound',
    ) as QuoteEmail[];
    return {
      count: emails.length,
      quotes: emails.map((e) => ({
        forwarderId: e.truthQuote?.forwarderId,
        forwarderName: e.truthQuote?.forwarderName,
        parsed: e.parsedQuote
          ? {
              freightTotal: e.parsedQuote.freightTotal,
              unitPrice: e.parsedQuote.unitPrice,
              surcharges: e.parsedQuote.surcharges,
              transitDays: e.parsedQuote.transitDays,
              airline: e.parsedQuote.airline,
              validity: e.parsedQuote.validity,
            }
          : null,
      })),
    };
  },
};

export const viewRecommendationTool: ToolDefinition = {
  name: 'view_recommendation',
  description: '查看某询价单的 AI 推荐结果（推荐货代/理由/排序）。',
  parameters: z.object({ inquiryId: z.string() }),
  execute: async (args, context) => {
    const world = getWorld(context.userId);
    const ev = world.evaluations[args.inquiryId];
    return ev ? { ok: true, recommendation: ev } : { ok: false, message: '尚未评估，请先 evaluate_quotes' };
  },
};
