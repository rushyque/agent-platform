import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

export const listOrdersTool: ToolDefinition = {
  name: "saleshub_list_orders",
  description:
    "查询当前用户可见的订单列表（销售员只看自己的订单，管理员/主管看全部）。" +
    "返回订单号、客户、销售员、金额（总额/已收/余额）、币种、状态、下单日期、发货日期。" +
    "支持按订单号、客户名、状态、下单日期范围（startDate/endDate）过滤。" +
    "日期用 YYYY-MM-DD，或直接传整月如 startDate='2026-07-01', endDate='2026-07-31' 表示某月。" +
    "用于回答「我的订单有哪些」「最近订单」「某客户订单」「某月订单」等问题。",
  parameters: z.object({
    orderNo: z.string().optional().describe("工单号/订单号，精确匹配，如 24CMRD1224"),
    customer: z.string().optional().describe("客户名，模糊匹配"),
    startDate: z.string().optional().describe("下单日期起（含），YYYY-MM-DD"),
    endDate: z.string().optional().describe("下单日期止（含），YYYY-MM-DD"),
    status: z
      .enum(["已完成", "未收款", "进行中", "已取消", "待收款"])
      .optional()
      .describe("订单状态过滤"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const filters: Record<string, string | number> = {};
    if (args.orderNo) filters.orderNo = String(args.orderNo);
    if (args.customer) filters.customerName = String(args.customer);
    if (args.status) filters.status = String(args.status);
    if (args.startDate) filters.startDate = String(args.startDate);
    if (args.endDate) filters.endDate = String(args.endDate);
    const orders = await hubFetch(ctx, "/api/orders/filter", {
      method: "POST",
      body: JSON.stringify(filters),
    });
    const list = (Array.isArray(orders) ? orders : []).slice(0, 50);
    return {
      count: list.length,
      orders: list.map((o: any) => ({
        id: o.id,
        orderNo: o.orderNo,
        customerName: o.customerName,
        salesPerson: o.salesPerson,
        status: o.status,
        currency: o.currency || o.currencySymbol || "",
        totalAmount: o.totalOrderAmount ?? o.totalAmount ?? 0,
        receivedAmount: o.receivedAmount ?? 0,
        balanceAmount: o.balanceAmount ?? 0,
        orderDate: o.orderDate,
        actualShipDate: o.actualShipDate,
      })),
    };
  },
};

export const orderDetailTool: ToolDefinition = {
  name: "saleshub_order_detail",
  description:
    "查询单个订单的完整详情：订单基础信息 + 收款计划与收款记录。" +
    "用于回答「某订单收了多少钱」「还有多少未收」「某期款什么时候到」等问题。参数传订单 id 或工单号。",
  parameters: z.object({
    id: z.number().optional().describe("订单 id（优先）"),
    orderNo: z.string().optional().describe("工单号/订单号，如 24CMRD1224"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    let id = args.id;
    if (!id && args.orderNo) {
      // Resolve order id by number via list+filter, then take the first match.
      const orders = await hubFetch<any[]>(ctx, "/api/orders/filter", {
        method: "POST",
        body: JSON.stringify({ orderNo: String(args.orderNo), limit: 5 }),
      });
      if (!Array.isArray(orders) || orders.length === 0) {
        return { ok: false, message: `未找到工单 ${args.orderNo}` };
      }
      id = orders[0].id;
    }
    if (id == null) {
      return { ok: false, message: "缺少订单 id 或工单号，请先提供其中一个" };
    }
    const order = await hubFetch<any>(ctx, `/api/orders/${id}`);
    if (!order || !order.id) {
      return { ok: false, message: `未找到订单 id=${id}` };
    }
    // Payment plans / records are separate endpoints; fetch them best-effort.
    let plans: any[] = [];
    let records: any[] = [];
    try {
      plans = await hubFetch<any[]>(ctx, `/api/orders/${id}/payment-plans`);
    } catch {
      plans = [];
    }
    try {
      records = await hubFetch<any[]>(ctx, `/api/orders/${id}/payment-records`);
    } catch {
      records = [];
    }
    return {
      order: {
        id: order.id,
        orderNo: order.orderNo,
        customerName: order.customerName,
        salesPerson: order.salesPerson,
        status: order.status,
        currency: order.currency || order.currencySymbol || "",
        totalAmount: order.totalOrderAmount ?? order.totalAmount ?? 0,
        receivedAmount: order.receivedAmount ?? 0,
        balanceAmount: order.balanceAmount ?? 0,
        orderDate: order.orderDate,
        actualShipDate: order.actualShipDate,
      },
      paymentPlans: (plans || []).map((p: any) => ({
        seq: p.receiptSeq,
        amount: p.amount,
        dueDate: p.dueDate,
        actualDate: p.actualDate,
        status: p.status,
      })),
      paymentRecords: (records || []).map((r: any) => ({
        seq: r.receiptSeq,
        amount: r.amount,
        date: r.actualDate || r.paymentDate,
        status: r.status,
        remark: r.remark,
      })),
    };
  },
};

export const orderStatsTool: ToolDefinition = {
  name: "saleshub_order_stats",
  description:
    "统计当前用户可见订单的聚合数据：订单数、总额、已收/未收金额，" +
    "以及按状态、按业务员、按币种的分组。" +
    "支持按下单日期范围（startDate/endDate，YYYY-MM-DD）、客户、状态过滤，沿用当前用户的权限范围。" +
    "用于一次性回答「某月/某段期间有多少单、总额多少、已收未收多少、按状态/业务员/币种分布」等统计类问题，" +
    "不必再靠拉取订单列表逐条累加。金额跨币种时以 byCurrency 为准。",
  parameters: z.object({
    startDate: z.string().optional().describe("下单日期起（含），YYYY-MM-DD"),
    endDate: z.string().optional().describe("下单日期止（含），YYYY-MM-DD"),
    customer: z.string().optional().describe("客户名，模糊匹配"),
    status: z
      .enum(["已完成", "未收款", "进行中"])
      .optional()
      .describe("订单状态过滤（数据实际只产出 已完成/未收款/进行中）"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const filters: Record<string, string> = {};
    if (args.startDate) filters.startDate = String(args.startDate);
    if (args.endDate) filters.endDate = String(args.endDate);
    if (args.customer) filters.customerName = String(args.customer);
    if (args.status) filters.status = String(args.status);
    const stats = await hubFetch(ctx, "/api/orders/stats", {
      method: "POST",
      body: JSON.stringify(filters),
    });
    return stats;
  },
};
