// 询价提交组（销售动作）
import { z } from 'zod';
import type { ToolDefinition } from '../../../types/agent-config.js';
import { createInquiry, setPreference } from '../engine.js';
import { getWorld } from '../state.js';

export const createInquiryTool: ToolDefinition = {
  name: 'create_inquiry',
  description: '销售录入货物询价单。提供货物信息（品名/重量/箱数/目的地/机场三字码/目的国）、贸易条款、评估偏好。生成草稿状态询价单。',
  parameters: z.object({
    cargoName: z.string().describe('货物品名，如 PET 注坯模具'),
    weight: z.number().describe('重量 kg'),
    boxes: z.number().describe('箱数'),
    destination: z.string().describe('目的城市，如 Lagos'),
    destCode: z.string().describe('目的机场三字码，如 LOS/JFK/FRA'),
    destCountry: z.string().describe('目的国，如 尼日利亚'),
    terms: z.string().describe('贸易条款，如 CIF/DDU/DAP/FOB/CPT'),
    preference: z.enum(['price_first', 'time_first', 'balanced', 'service_first']).optional().describe('评估偏好，缺省 balanced'),
    shipper: z.string().optional().describe('销售/发货人，缺省 销售·Cherry'),
  }),
  execute: async (args, context) => {
    const res = createInquiry(context.userId, {
      shipper: args.shipper,
      cargo: {
        name: args.cargoName,
        weight: args.weight,
        boxes: args.boxes,
        destination: args.destination,
        destCode: args.destCode.toUpperCase(),
        destCountry: args.destCountry,
      },
      terms: args.terms,
      preference: args.preference,
    });
    if (!res.ok || !res.data) return { ok: false, message: res.message };
    const iq = res.data;
    return {
      ok: true,
      message: res.message,
      inquiry: {
        id: iq.id,
        inquiryNo: iq.inquiryNo,
        status: iq.status,
        preference: iq.preference,
        terms: iq.terms,
        cargo: iq.cargo,
      },
      hint: '下一步：dispatch_inquiry_emails 向货代发送询价。',
    };
  },
};

export const setPreferenceTool: ToolDefinition = {
  name: 'set_preference',
  description: '设置某询价单的评估偏好（价格/时效/平衡/服务），影响 AI 评估推荐。',
  parameters: z.object({
    inquiryId: z.string().describe('询价单 ID，如 INQ-26-0001'),
    preference: z.enum(['price_first', 'time_first', 'balanced', 'service_first']),
  }),
  execute: async (args, context) => {
    const res = setPreference(context.userId, args.inquiryId, args.preference);
    return res.ok ? { ok: true, message: res.message } : { ok: false, message: res.message };
  },
};

export const listForwardersTool: ToolDefinition = {
  name: 'list_forwarders',
  description: '查看预设货代公司池（8 家，含风格/擅长航线/评分）。',
  parameters: z.object({}),
  execute: async (_args, context) => {
    const world = getWorld(context.userId);
    return {
      count: world.forwarders.length,
      forwarders: world.forwarders.map((f) => ({
        id: f.id,
        name: f.name,
        style: f.style,
        specialties: f.specialties,
        rating: f.rating,
        contact: f.contact,
      })),
    };
  },
};

export const listInquiriesTool: ToolDefinition = {
  name: 'list_inquiries',
  description: '查看当前用户的所有询价单及状态。',
  parameters: z.object({}),
  execute: async (_args, context) => {
    const world = getWorld(context.userId);
    return {
      count: world.inquiries.length,
      inquiries: world.inquiries.map((iq) => ({
        id: iq.id,
        cargo: iq.cargo.name,
        destination: iq.cargo.destination,
        destCode: iq.cargo.destCode,
        weight: iq.cargo.weight,
        terms: iq.terms,
        preference: iq.preference,
        status: iq.status,
        selectedForwarderId: iq.selectedForwarderId,
      })),
    };
  },
};

export const viewInquiryTool: ToolDefinition = {
  name: 'view_inquiry',
  description: '查看单个询价单详情（含已收报价数、已解析数、是否已评估）。',
  parameters: z.object({ inquiryId: z.string() }),
  execute: async (args, context) => {
    const world = getWorld(context.userId);
    const iq = world.inquiries.find((i) => i.id === args.inquiryId);
    if (!iq) return { ok: false, message: `未找到询价 ${args.inquiryId}` };
    const quoteEmails = world.emails.filter((e) => e.inquiryId === iq.id && e.kind === 'quote_inbound');
    const parsedCount = quoteEmails.filter((e) => (e as any).parsedQuote).length;
    return {
      ok: true,
      inquiry: {
        id: iq.id,
        inquiryNo: iq.inquiryNo,
        cargo: iq.cargo,
        terms: iq.terms,
        preference: iq.preference,
        status: iq.status,
        selectedForwarderId: iq.selectedForwarderId,
      },
      stats: {
        quoteCount: quoteEmails.length,
        parsedCount,
        evaluated: !!world.evaluations[iq.id],
      },
    };
  },
};
