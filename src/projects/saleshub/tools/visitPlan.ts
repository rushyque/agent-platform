import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

interface VisitPlanView {
  id: number;
  visitDate?: string | null;
  companyName?: string | null;
  visitorName?: string | null;
  visitPurpose?: string | null;
  createdBy?: string;
  [key: string]: unknown;
}

/** 只读：当前用户可见的拜访计划清单（销售员只看自己/同组，管理员/主管看全部）。 */
export const listVisitPlansTool: ToolDefinition = {
  name: "saleshub_list_visit_plans",
  description:
    "查询当前用户可见的客户拜访计划（到访计划）列表。可用于回答「有哪些拜访计划」「某客户的到访计划」「本周/本月有哪些到访」等问题，" +
    "也为发送拜访计划邮件提供 planId（每条记录带 id）。支持按关键词（companyName/visitorName/visitPurpose）、年份、创建人过滤。",
  parameters: z.object({
    keyword: z.string().optional().describe("关键词过滤（匹配公司名/到访人/目的/负责人）"),
    year: z.number().optional().describe("按到访日期年份过滤（如 2026）"),
    createdBy: z.string().optional().describe("按创建人 full_name 过滤"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const qs = new URLSearchParams();
    if (args.keyword) qs.set("keyword", String(args.keyword));
    if (args.year) qs.set("year", String(args.year));
    if (args.createdBy) qs.set("createdBy", String(args.createdBy));
    qs.set("page", "1");
    qs.set("pageSize", "200");
    const res = await hubFetch<{ data: VisitPlanView[]; total: number }>(
      ctx,
      `/api/visit-plans?${qs.toString()}`,
    );
    const list = Array.isArray(res?.data) ? res.data : [];
    return {
      total: res?.total ?? list.length,
      count: list.length,
      plans: list.slice(0, 200).map((p) => ({
        id: p.id,
        visitDate: p.visitDate,
        companyName: p.companyName,
        visitorName: p.visitorName,
        visitPurpose: p.visitPurpose,
        createdBy: p.createdBy,
      })),
    };
  },
};

interface Recipient {
  id: number;
  fullName: string;
  email: string;
  role: string;
  position: string;
}

/** 只读：发送拜访计划邮件时可选的收件人候选（用于填充 recipientIds）。 */
export const listVisitPlanRecipientsTool: ToolDefinition = {
  name: "saleshub_visit_plan_recipients",
  description:
    "查询发送拜访计划邮件时可选的收件人候选列表（含 id / 姓名 / 邮箱 / 角色 / 职位）。" +
    "用户要让某个收件人收到拜访计划邮件时，先用本工具拿候选 id，再调用发送邮件的写操作。",
  parameters: z.object({}),
  readonly: true,
  execute: async (_args, context) => {
    const ctx = context as SalesContext;
    const res = await hubFetch<{ data: Recipient[] }>(ctx, "/api/visit-plans/recipients");
    const list = Array.isArray(res?.data) ? res.data : [];
    return {
      count: list.length,
      recipients: list.map((r) => ({
        id: r.id,
        name: r.fullName,
        email: r.email,
        role: r.role,
        position: r.position,
      })),
    };
  },
};

/**
 * 写操作：发送拜访计划邮件（带 Word 附件）。真实副作用，且仅完全模式可用 ——
 * 由 ToolDefinition.fullModeOnly 标记，中台在 browse/act 模式一律不暴露该工具。
 * dryRun=true 只构造邮件不实际发送（安全验证用，绝不打扰收件人）。
 */
export const sendVisitPlanEmailTool: ToolDefinition = {
  name: "saleshub_send_visit_plan_email",
  description:
    "发送某条拜访计划（到访计划）的邮件（含 Word 附件）给指定收件人。这是写入操作，仅完全模式可用。" +
    "参数 planId 为拜访计划 id（先用 saleshub_list_visit_plans 拿到），recipientIds 为收件人用户 id 数组（先用 saleshub_visit_plan_recipients 拿到）。" +
    "dryRun=true 时仅构造邮件、不实际发送。发送前请向用户确认收件人无误。",
  parameters: z.object({
    planId: z.number().describe("要发送的拜访计划 id"),
    recipientIds: z
      .array(z.number())
      .min(1)
      .describe("收件人用户 id 数组，至少一位"),
    dryRun: z.boolean().optional().describe("是否仅测试构造邮件（不实际发送），默认 false"),
  }),
  fullModeOnly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const body: Record<string, unknown> = { recipientIds: args.recipientIds };
    if (args.dryRun === true) body.dryRun = true;
    const res = await hubFetch<{
      data?: {
        dryRun?: boolean;
        sent?: boolean;
        recipients?: { name: string; email: string }[];
        subject?: string;
        attachmentName?: string;
      };
      message?: string;
    }>(ctx, `/api/visit-plans/${args.planId}/send-email`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const d = res?.data || {};
    return {
      ok: true,
      dryRun: d.dryRun === true,
      sent: d.sent === true,
      recipients: Array.isArray(d.recipients) ? d.recipients : [],
      subject: d.subject ?? "",
      attachmentName: d.attachmentName ?? "",
      message: res?.message ?? (d.dryRun ? "仅测试构造邮件（未发送）" : "邮件发送成功"),
    };
  },
};
