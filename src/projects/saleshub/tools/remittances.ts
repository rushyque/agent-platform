import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

interface ApprovedRemittance {
  id: number;
  date?: string;
  bank?: string;
  method?: string;
  company?: string;
  amount?: string | number;
  currency?: string;
  sales?: string;
  status?: string;
}

function inRange(dateStr: string | undefined, start?: string, end?: string): boolean {
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

export const listRemittancesTool: ToolDefinition = {
  name: "saleshub_list_remittances",
  description:
    "查询当前用户已审核的汇款/收款记录（approved remittances）。" +
    "返回每笔的记录日期、收款银行、收款方式、付款/客户公司、金额、币种、状态。" +
    "支持按日期范围（startDate/endDate，YYYY-MM-DD）过滤，用于回答" +
    "「某月有多少汇款/收款记录」「近N笔汇款」「某客户的到账」等问题。" +
    "注意这里统计的是汇款到账记录条数，不含未审核/草稿记录。",
  parameters: z.object({
    startDate: z.string().optional().describe("记录日期起（含），YYYY-MM-DD"),
    endDate: z.string().optional().describe("记录日期止（含），YYYY-MM-DD"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const records = await hubFetch<ApprovedRemittance[]>(ctx, "/api/remittance/my-approved");
    const list = (Array.isArray(records) ? records : []).filter((r) =>
      inRange(r.date, args.startDate, args.endDate),
    );
    return {
      count: list.length,
      totalAmountText: `${list.length} 笔汇款记录`,
      remittances: list.slice(0, 50).map((r) => ({
        id: r.id,
        date: r.date,
        bank: r.bank,
        method: r.method,
        company: r.company,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
      })),
    };
  },
};
