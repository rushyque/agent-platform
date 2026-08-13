import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

export const reconReportTool: ToolDefinition = {
  name: "saleshub_recon_report",
  description:
    "查询当前销售员的「冲红 / 预付转收款」对账报表（销售员视角，只返回当前登录销售员自己的数据）。" +
    "包含三块：① 冲红销售发票（red_icsale：红字单号、日期、客户、金额净额/含税、所冲蓝字、关联工单、核销状态）；" +
    "② 冲红费用发票（red_expenses）；③ 预付转收款（prepay：预收单、工单、收款与核销金额、币种）及汇总 prepay_meta。" +
    "用于回答「我有多少冲红单」「某客户的冲红/预付款」「预付转收款情况」「对冲对账」等问题。" +
    "数据按当前销售员过滤，金额以接口返回为准。",
  parameters: z.object({}),
  readonly: true,
  execute: async (_args, context) => {
    const ctx = context as SalesContext;
    const report = await hubFetch<any>(ctx, "/api/recon");
    const recent = report?.recent || {};
    const redIcsale = Array.isArray(recent.red_icsale) ? recent.red_icsale : [];
    const redExpenses = Array.isArray(recent.red_expenses) ? recent.red_expenses : [];
    const prepay = Array.isArray(recent.prepay) ? recent.prepay : [];
    const prepayNoWo = Array.isArray(recent.prepay_no_wo) ? recent.prepay_no_wo : [];
    const meta = recent.prepay_meta || {};
    const sumNet = (arr: any[], key: string) =>
      arr.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    return {
      generatedAt: report?.meta?.generated_at || null,
      redFrom: report?.meta?.red_from || null,
      counts: {
        redIcsale: redIcsale.length,
        redExpenses: redExpenses.length,
        prepay: prepay.length,
        prepayNoWo: prepayNoWo.length,
      },
      sums: {
        redIcsaleNet: sumNet(redIcsale, "net"),
        prepayAmount: sumNet(prepay, "amount_for"),
      },
      prepayMeta: meta,
      redIcsale: redIcsale.slice(0, 50).map((r: any) => ({
        billNo: r.bill_no,
        date: r.date,
        customerName: r.cust_name,
        currency: r.currency,
        net: r.net,
        netIncl: r.net_incl,
        srcBlue: r.src_blue,
        workOrder: r.wo,
      })),
      redExpenses: redExpenses.slice(0, 50).map((r: any) => ({
        billNo: r.bill_no,
        date: r.date,
        customerName: r.cust_name,
        currency: r.currency,
        net: r.net,
        workOrder: r.ord,
      })),
      prepay: prepay.slice(0, 50).map((r: any) => ({
        number: r.number,
        date: r.date,
        customerName: r.cust_name,
        currency: r.currency,
        amountFor: r.amount_for,
        checkAmountFor: r.check_amount_for,
        workOrder: r.wo,
      })),
    };
  },
};
