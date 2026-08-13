import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

interface RemittanceRecord {
  id: number;
  date?: string;
  bank?: string;
  method?: string;
  company?: string;
  amount?: string | number;
  currency?: string;
  fee?: string | number;
  sales?: string;
  status?: string;
  rejectReason?: string | null;
  claimedFromPool?: number;
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
    "查询当前登录销售员自己的**全部汇款/收款记录**（含待填写 pending、已填写 filled、被驳回 rejected、已审核 approved 各状态）。" +
    "返回每笔的 id、记录日期、收款银行、收款方式、付款/客户公司、金额、币种、费用(fee)、当前状态、驳回原因、是否来自共享池。" +
    "支持按日期范围（startDate/endDate，YYYY-MM-DD）过滤，用于回答" +
    "「某月有多少汇款/收款记录」「近N笔汇款」「某客户的到账」「我还有哪些待填写/被驳回的汇款」等问题。" +
    "注意：这里返回的是当前销售员自己的全部收款记录（不再只限已审核），不含草稿（draft）。",
  parameters: z.object({
    startDate: z.string().optional().describe("记录日期起（含），YYYY-MM-DD"),
    endDate: z.string().optional().describe("记录日期止（含），YYYY-MM-DD"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const records = await hubFetch<RemittanceRecord[]>(ctx, "/api/remittance/pending");
    const list = (Array.isArray(records) ? records : []).filter((r) =>
      inRange(r.date, args.startDate, args.endDate),
    );
    const byStatus = (s: string) => list.filter((r) => r.status === s).length;
    return {
      count: list.length,
      totalAmountText: `${list.length} 笔汇款/收款记录`,
      byStatus: {
        pending: byStatus("pending"),
        filled: byStatus("filled"),
        rejected: byStatus("rejected"),
        approved: byStatus("approved"),
      },
      remittances: list.slice(0, 50).map((r) => ({
        id: r.id,
        date: r.date,
        bank: r.bank,
        method: r.method,
        company: r.company,
        amount: r.amount,
        currency: r.currency,
        fee: r.fee,
        status: r.status,
        rejectReason: r.rejectReason,
        claimedFromPool: r.claimedFromPool,
      })),
    };
  },
};
