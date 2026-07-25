// AI 核心组（中台验证点）：工具内部调 generateObject 做结构化提取/评估
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { getWorld } from '../state.js';
import { recordParseResult, recordEvaluation } from '../engine.js';
import { parseQuoteEmailsWithLLM, evaluateQuotesWithLLM } from '../llm-helpers.js';
import type { QuoteEmail } from '../types.js';

export const parseQuoteEmailsTool: ToolDefinition = {
  name: 'parse_quote_emails',
  description:
    '【AI 核心 1】用 AI 解析某询价单的所有报价邮件正文，提取结构化数据（运费/单价/燃油/安检/战争险/时效/航司/航班周期/有效期）。返回每家解析结果并写回。',
  parameters: z.object({ inquiryId: z.string().describe('询价单 ID') }),
  execute: async (args, context) => {
    const world = getWorld(context.userId);
    const iq = world.inquiries.find((i) => i.id === args.inquiryId);
    if (!iq) return { ok: false, message: `未找到询价 ${args.inquiryId}` };
    const quoteEmails = world.emails.filter(
      (e) => e.inquiryId === args.inquiryId && e.kind === 'quote_inbound',
    ) as QuoteEmail[];
    if (quoteEmails.length === 0) return { ok: false, message: '尚无报价邮件，请先 collect_quote_emails' };

    const { parsed, trace } = await parseQuoteEmailsWithLLM(quoteEmails, world.forwarders);
    if (parsed.length > 0) recordParseResult(context.userId, args.inquiryId, parsed);

    return {
      ok: parsed.length > 0,
      message: parsed.length > 0 ? `解析 ${parsed.length} 份报价` : '解析失败，见 trace',
      parsedQuotes: parsed.map((p) => ({
        forwarderId: p.forwarderId,
        forwarderName: p.forwarderName,
        freightTotal: p.freightTotal,
        unitPrice: p.unitPrice,
        surcharges: p.surcharges,
        transitDays: p.transitDays,
        airline: p.airline,
        validity: p.validity,
      })),
      trace,
      hint: parsed.length > 0 ? '下一步：evaluate_quotes 做偏好评估。' : '解析失败，可重试。',
    };
  },
};

export const evaluateQuotesTool: ToolDefinition = {
  name: 'evaluate_quotes',
  description: '【AI 核心 2】汇总某询价单已解析的全部报价 + 评估偏好，用 AI 生成最优推荐、理由与排序。',
  parameters: z.object({ inquiryId: z.string().describe('询价单 ID') }),
  execute: async (args, context) => {
    const world = getWorld(context.userId);
    const iq = world.inquiries.find((i) => i.id === args.inquiryId);
    if (!iq) return { ok: false, message: `未找到询价 ${args.inquiryId}` };
    const parsed = world.emails
      .filter((e) => e.inquiryId === args.inquiryId && e.kind === 'quote_inbound' && (e as QuoteEmail).parsedQuote)
      .map((e) => (e as QuoteEmail).parsedQuote!) as NonNullable<QuoteEmail['parsedQuote']>[];
    if (parsed.length === 0) return { ok: false, message: '尚无已解析报价，请先 parse_quote_emails' };

    const { evaluation, trace } = await evaluateQuotesWithLLM(parsed, iq, world.forwarders, iq.preference);
    if (evaluation) recordEvaluation(context.userId, args.inquiryId, evaluation);

    return {
      ok: !!evaluation,
      message: evaluation ? `推荐：${evaluation.recommendedForwarderName}` : '评估失败，见 trace',
      recommendation: evaluation
        ? {
            recommendedForwarderId: evaluation.recommendedForwarderId,
            recommendedForwarderName: evaluation.recommendedForwarderName,
            reason: evaluation.reason,
            preferenceUsed: evaluation.preferenceUsed,
            ranking: evaluation.ranking,
          }
        : null,
      trace,
      hint: evaluation ? '下一步：notify_manager_review 进入审核，或 negotiate_with_forwarder 议价。' : '评估失败，可重试。',
    };
  },
};
