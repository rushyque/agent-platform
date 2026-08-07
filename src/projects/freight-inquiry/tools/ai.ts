// quote -- resource-based tool (replaces 4 flat tools)
// Modes: parse / evaluate / view_comparison / view_recommendation
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { getWorld } from '../state.js';
import { recordParseResult, recordEvaluation } from '../engine.js';
import { parseQuoteEmailsWithLLM, evaluateQuotesWithLLM } from '../llm-helpers.js';
import type { QuoteEmail } from '../types.js';

export const quoteTool: ToolDefinition = {
  name: 'quote',
  description:
    'Quote parsing & evaluation operations. Modes:\n' +
    '- parse: AI-parse all quote emails for an inquiry (extract freight/unit price/surcharges/transit/airline).\n' +
    '- evaluate: AI-evaluate parsed quotes with preference, produce ranking + recommendation.\n' +
    '- view_comparison: view comparison table (freight/unit price/surcharges/transit for each forwarder).\n' +
    '- view_recommendation: view the AI recommendation result.',
  parameters: z.object({
    mode: z.enum(['parse', 'evaluate', 'view_comparison', 'view_recommendation']).describe('Quote action'),
    inquiryId: z.string().describe('Inquiry id'),
  }),
  readonly: true,
  execute: async (args, context) => {
    const userId = context.userId;
    const world = getWorld(userId);
    const iq = world.inquiries.find((i) => i.id === args.inquiryId);
    if (!iq) return { ok: false, message: `Inquiry ${args.inquiryId} not found` };

    if (args.mode === 'parse') {
      const quoteEmails = world.emails.filter(
        (e) => e.inquiryId === args.inquiryId && e.kind === 'quote_inbound',
      ) as QuoteEmail[];
      if (quoteEmails.length === 0) return { ok: false, message: 'No quote emails yet. Collect them first.' };
      const { parsed, trace } = await parseQuoteEmailsWithLLM(quoteEmails, world.forwarders);
      if (parsed.length > 0) recordParseResult(userId, args.inquiryId, parsed);
      return {
        ok: parsed.length > 0,
        message: parsed.length > 0 ? `Parsed ${parsed.length} quotes` : 'Parse failed, see trace',
        parsedQuotes: parsed.map((p) => ({
          forwarderId: p.forwarderId, forwarderName: p.forwarderName,
          freightTotal: p.freightTotal, unitPrice: p.unitPrice,
          surcharges: p.surcharges, transitDays: p.transitDays,
          airline: p.airline, validity: p.validity,
        })),
        trace,
        hint: parsed.length > 0 ? 'Next: evaluate quotes.' : 'Parse failed, can retry.',
      };
    }

    if (args.mode === 'evaluate') {
      const parsed = world.emails
        .filter((e) => e.inquiryId === args.inquiryId && e.kind === 'quote_inbound' && (e as QuoteEmail).parsedQuote)
        .map((e) => (e as QuoteEmail).parsedQuote!) as NonNullable<QuoteEmail['parsedQuote']>[];
      if (parsed.length === 0) return { ok: false, message: 'No parsed quotes. Parse first.' };
      const { evaluation, trace } = await evaluateQuotesWithLLM(parsed, iq, world.forwarders, iq.preference);
      if (evaluation) recordEvaluation(userId, args.inquiryId, evaluation);
      return {
        ok: !!evaluation,
        message: evaluation ? `Recommended: ${evaluation.recommendedForwarderName}` : 'Evaluation failed, see trace',
        recommendation: evaluation
          ? {
              recommendedForwarderId: evaluation.recommendedForwarderId,
              recommendedForwarderName: evaluation.recommendedForwarderName,
              reason: evaluation.reason, preferenceUsed: evaluation.preferenceUsed, ranking: evaluation.ranking,
            }
          : null,
        trace,
        hint: evaluation ? 'Next: notify manager for review, or negotiate.' : 'Evaluation failed, can retry.',
      };
    }

    if (args.mode === 'view_comparison') {
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
                freightTotal: e.parsedQuote.freightTotal, unitPrice: e.parsedQuote.unitPrice,
                surcharges: e.parsedQuote.surcharges, transitDays: e.parsedQuote.transitDays,
                airline: e.parsedQuote.airline, validity: e.parsedQuote.validity,
              }
            : null,
        })),
      };
    }

    // view_recommendation
    const ev = world.evaluations[args.inquiryId];
    return ev ? { ok: true, recommendation: ev } : { ok: false, message: 'Not evaluated yet. Evaluate first.' };
  },
};
