// inquiry -- resource-based tool (replaces 5 flat tools)
// Modes: create / list / view / set_preference / list_forwarders
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { createInquiry, setPreference } from '../engine.js';
import { getWorld } from '../state.js';

export const inquiryTool: ToolDefinition = {
  name: 'inquiry',
  description:
    'Freight inquiry operations. Modes:\n' +
    '- create: create a cargo inquiry (draft status). Provide cargo details + trade terms.\n' +
    '- list: list all inquiries with status.\n' +
    '- view: view a single inquiry detail (quote/parsed/evaluated counts).\n' +
    '- set_preference: set evaluation preference (price/time/balanced/service).\n' +
    '- list_forwarders: view the forwarder pool (8 companies, routes, ratings).',
  parameters: z.object({
    mode: z.enum(['create', 'list', 'view', 'set_preference', 'list_forwarders']).describe('Inquiry action'),
    inquiryId: z.string().optional().describe('[view/set_preference] Inquiry id'),
    preference: z
      .enum(['price_first', 'time_first', 'balanced', 'service_first'])
      .optional()
      .describe('[create/set_preference] Evaluation preference'),
    // create-specific
    cargoName: z.string().optional().describe('[create] Cargo name'),
    weight: z.number().optional().describe('[create] Weight in kg'),
    boxes: z.number().optional().describe('[create] Box count'),
    destination: z.string().optional().describe('[create] Destination city'),
    destCode: z.string().optional().describe('[create] Airport code (3-letter)'),
    destCountry: z.string().optional().describe('[create] Destination country'),
    terms: z.string().optional().describe('[create] Trade terms (CIF/DDU/DAP/FOB/CPT)'),
    shipper: z.string().optional().describe('[create] Shipper name'),
  }),
  readonly: true,
  execute: async (args, context) => {
    const userId = context.userId;

    if (args.mode === 'list_forwarders') {
      const world = getWorld(userId);
      return {
        count: world.forwarders.length,
        forwarders: world.forwarders.map((f) => ({
          id: f.id, name: f.name, style: f.style, specialties: f.specialties, rating: f.rating, contact: f.contact,
        })),
      };
    }

    if (args.mode === 'list') {
      const world = getWorld(userId);
      return {
        count: world.inquiries.length,
        inquiries: world.inquiries.map((iq) => ({
          id: iq.id, cargo: iq.cargo.name, destination: iq.cargo.destination,
          destCode: iq.cargo.destCode, weight: iq.cargo.weight,
          terms: iq.terms, preference: iq.preference, status: iq.status,
          selectedForwarderId: iq.selectedForwarderId,
        })),
      };
    }

    if (args.mode === 'view') {
      const world = getWorld(userId);
      const iq = world.inquiries.find((i) => i.id === args.inquiryId);
      if (!iq) return { ok: false, message: `Inquiry ${args.inquiryId} not found` };
      const quoteEmails = world.emails.filter((e) => e.inquiryId === iq.id && e.kind === 'quote_inbound');
      const parsedCount = quoteEmails.filter((e) => (e as any).parsedQuote).length;
      return {
        ok: true,
        inquiry: {
          id: iq.id, inquiryNo: iq.inquiryNo, cargo: iq.cargo, terms: iq.terms,
          preference: iq.preference, status: iq.status, selectedForwarderId: iq.selectedForwarderId,
        },
        stats: { quoteCount: quoteEmails.length, parsedCount, evaluated: !!world.evaluations[iq.id] },
      };
    }

    if (args.mode === 'set_preference') {
      const res = setPreference(userId, args.inquiryId!, args.preference!);
      return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.message };
    }

    // create
    const res = createInquiry(userId, {
      shipper: args.shipper,
      cargo: {
        name: args.cargoName!, weight: args.weight!, boxes: args.boxes!,
        destination: args.destination!, destCode: (args.destCode || '').toUpperCase(),
        destCountry: args.destCountry!,
      },
      terms: args.terms!,
      preference: args.preference,
    });
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    const iq = res.data;
    return {
      ok: true,
      message: res.message,
      inquiry: { id: iq.id, inquiryNo: iq.inquiryNo, status: iq.status, preference: iq.preference, terms: iq.terms, cargo: iq.cargo },
      hint: 'Next: dispatch inquiry emails to forwarders.',
    };
  },
};
