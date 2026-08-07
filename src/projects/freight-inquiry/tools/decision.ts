// decision -- resource-based tool (replaces 5 flat tools)
// Modes: notify_review / review / negotiate / record / confirm
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import {
  notifyManagerReview,
  managerReview,
  negotiate,
  applyNegotiationToParsed,
  recordDecision,
  confirmForwarder,
} from '../engine.js';
import { getWorld } from '../state.js';
import { parseQuoteEmailsWithLLM } from '../llm-helpers.js';

export const decisionTool: ToolDefinition = {
  name: 'decision',
  description:
    'Manager decision operations (requires evaluation first). Modes:\n' +
    '- notify_review: send review notification email to sales manager.\n' +
    '- review: manager approves/rejects AI recommendation (must notify first).\n' +
    '- negotiate: negotiate with a forwarder (AI auto-parses counter-offer).\n' +
    '- record: record final forwarder selection + reason.\n' +
    '- confirm: send booking confirmation to selected forwarder.',
  parameters: z.object({
    mode: z.enum(['notify_review', 'review', 'negotiate', 'record', 'confirm']).describe('Decision action'),
    inquiryId: z.string().describe('Inquiry id'),
    managerEmail: z.string().optional().describe('[notify_review] Manager email (default manager@fscargo.com)'),
    decision: z
      .enum(['approve', 'reject'])
      .optional()
      .describe('[review] approve or reject'),
    note: z
      .string()
      .optional()
      .describe('[review/record] Review note or selection reason'),
    forwarderId: z.string().optional().describe('[negotiate/record] Forwarder id'),
    targetUnitPrice: z.number().optional().describe('[negotiate] Target unit price yuan/kg'),
  }),
  execute: async (args, context) => {
    const userId = context.userId;

    if (args.mode === 'notify_review') {
      const res = notifyManagerReview(userId, args.inquiryId, args.managerEmail ?? 'manager@fscargo.com');
      if (!res.ok || !res.data) return { ok: false, message: res.message };
      return {
        ok: true,
        message: res.message,
        email: { to: res.data.to, subject: res.data.subject },
        hint: 'Manager can review and decide.',
      };
    }

    if (args.mode === 'review') {
      const res = managerReview(userId, args.inquiryId, args.decision!, args.note!);
      if (!res.ok) return { ok: false, message: res.message };
      return {
        ok: true,
        message: res.message,
        decision: args.decision,
        hint:
          args.decision === 'approve'
            ? 'Next: record decision to select forwarder.'
            : 'Next: negotiate or re-evaluate.',
      };
    }

    if (args.mode === 'negotiate') {
      const res = negotiate(userId, args.inquiryId, args.forwarderId!, args.targetUnitPrice!);
      if (!res.ok || !res.data) return { ok: false, message: res.message };
      const negoEmail = res.data;
      const world = getWorld(userId);
      const { parsed, trace } = await parseQuoteEmailsWithLLM([negoEmail], world.forwarders);
      applyNegotiationToParsed(userId, args.inquiryId, args.forwarderId!);
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
        hint: 'Quote updated. Re-evaluate to see new recommendation.',
      };
    }

    if (args.mode === 'record') {
      const res = recordDecision(userId, args.inquiryId, args.forwarderId!, args.note!);
      return res.ok
        ? { ok: true, message: res.message, hint: 'Next: confirm forwarder booking.' }
        : { ok: false, message: res.message };
    }

    // confirm
    const res = confirmForwarder(userId, args.inquiryId);
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    return {
      ok: true,
      message: res.message,
      email: { to: res.data.to, subject: res.data.subject },
    };
  },
};
