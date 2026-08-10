import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

export const listCustomersTool: ToolDefinition = {
  name: "saleshub_list_customers",
  description:
    "查询当前用户可见的客户列表（销售员只看自己的客户）。" +
    "返回客户 id、名称、业务员、联系方式等。支持按客户名、业务员过滤。" +
    "用于回答「我的客户有哪些」「某客户信息」等问题。",
  parameters: z.object({
    name: z.string().optional().describe("客户名，模糊匹配"),
    salesPerson: z.string().optional().describe("业务员/销售员，精确匹配"),
    limit: z.number().optional().describe("最多返回条数，默认 20，最大 50"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const filters: Record<string, string | number> = {};
    if (args.name) filters.name = String(args.name);
    if (args.salesPerson) filters.salesPerson = String(args.salesPerson);
    filters.limit = args.limit ?? 20;
    const customers = await hubFetch(ctx, "/api/customers/filter", {
      method: "POST",
      body: JSON.stringify(filters),
    });
    const list = (Array.isArray(customers) ? customers : []).slice(0, 50);
    return {
      count: list.length,
      customers: list.map((c: any) => ({
        id: c.id,
        name: c.name || c.customerName,
        salesPerson: c.salesPerson || c.sales,
        country: c.country,
        contactPerson: c.contactPerson,
        phone: c.phone,
        email: c.email,
      })),
    };
  },
};

export const customerDetailTool: ToolDefinition = {
  name: "saleshub_customer_detail",
  description:
    "查询单个客户详情及其订单汇总。返回客户基本信息 + 该客户下的订单列表。" +
    "用于回答「某客户的订单有哪些」「某客户买了什么」等问题。参数传客户 id 或客户名。",
  parameters: z.object({
    id: z.number().optional().describe("客户 id（优先）"),
    name: z.string().optional().describe("客户名，用于按名称查找"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    let id = args.id;
    if (!id && args.name) {
      const customers = await hubFetch<any[]>(ctx, "/api/customers/filter", {
        method: "POST",
        body: JSON.stringify({ name: String(args.name), limit: 5 }),
      });
      if (!Array.isArray(customers) || customers.length === 0) {
        return { ok: false, message: `未找到客户 ${args.name}` };
      }
      id = customers[0].id;
    }
    if (id == null) {
      return { ok: false, message: "缺少客户 id 或名称，请先提供其中一个" };
    }
    const customer = await hubFetch<any>(ctx, `/api/customers/${id}`);
    if (!customer || !customer.name) {
      return { ok: false, message: `未找到客户 id=${id}` };
    }
    let orders: any[] = [];
    try {
      orders = await hubFetch<any[]>(ctx, `/api/customers/${id}/orders`);
    } catch {
      orders = [];
    }
    return {
      customer: {
        id: customer.id,
        name: customer.name || customer.customerName,
        salesPerson: customer.salesPerson || customer.sales,
        country: customer.country,
        contactPerson: customer.contactPerson,
        phone: customer.phone,
        email: customer.email,
      },
      orderCount: (orders || []).length,
      orders: (orders || []).slice(0, 20).map((o: any) => ({
        id: o.id,
        orderNo: o.orderNo,
        status: o.status,
        totalAmount: o.totalOrderAmount ?? o.totalAmount ?? 0,
        balanceAmount: o.balanceAmount ?? 0,
        orderDate: o.orderDate,
      })),
    };
  },
};
