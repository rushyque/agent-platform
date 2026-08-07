// email -- resource-based tool (replaces 3 flat tools)
// Modes: dispatch / collect / view
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { dispatchInquiryEmails, collectQuoteEmails } from '../engine.js';
import { getWorld } from '../state.js';

export const emailTool: ToolDefinition = {
  name: 'email',
  description:
    'Inquiry email operations. Modes:\n' +
    '- dispatch: send inquiry emails to matching forwarders (status draft -> sent).\n' +
    '- collect: collect forwarder quote replies (status sent -> quoting).\n' +
    '- view: list emails for an inquiry (optional kind filter).',
  parameters: z.object({
    mode: z.enum(['dispatch', 'collect', 'view']).describe('Email action'),
    inquiryId: z.string().describe('Inquiry id'),
    kind: z
      .enum(['inquiry_outbound', 'quote_inbound', 'negotiation_inbound', 'review_notice', 'confirm_notice'])
      .optional()
      .describe('[view] Email type filter'),
  }),
  readonly: true,
  execute: async (args, context) => {
    const userId = context.userId;

    if (args.mode === 'dispatch') {
      const res = dispatchInquiryEmails(userId, args.inquiryId);
      if (!res.ok || !res.data) return { ok: false, message: res.message };
      return {
        ok: true,
        message: res.message,
        dispatchedTo: (res.data as any[]).map((e) => e.to),
        hint: 'Next: collect quote emails from forwarders.',
      };
    }

    if (args.mode === 'collect') {
      const res = collectQuoteEmails(userId, args.inquiryId);
      if (!res.ok || !res.data) return { ok: false, message: res.message };
      return {
        ok: true,
        message: res.message,
        count: res.data.length,
        fromForwarders: res.data.map((q) => ({
          forwarderId: q.truthQuote?.forwarderId,
          forwarderName: q.truthQuote?.forwarderName,
        })),
        hint: 'Next: parse quote emails with AI.',
      };
    }

    // view
    const world = getWorld(userId);
    const list = world.emails.filter((e) => e.inquiryId === args.inquiryId && (!args.kind || e.kind === args.kind));
    return {
      count: list.length,
      emails: list.map((e) => ({
        id: e.id, kind: e.kind, from: e.from, to: e.to,
        subject: e.subject, receivedAt: e.receivedAt, parsed: !!(e as any).parsedQuote,
      })),
    };
  },
};
