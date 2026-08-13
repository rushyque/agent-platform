import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

interface OrderRecordRow {
  billNo?: string;
  orderDate?: string | null;
  deliveryDate?: string | null;
  salesPerson?: string;
  customerName?: string;
  poContractNo?: string;
  productType?: string;
  materials?: string;
  quantity?: number | null;
  unitPrice?: number | null;
  currency?: string;
  totalAmount?: number | null;
  shipDate?: string | null;
  shipNo?: string;
  invoiceDate?: string | null;
  invoiceNo?: string;
  country?: string;
  dataSource?: string;
  remark?: string;
  receiptSchedules?: unknown[];
}

interface OrderRecordsResponse {
  data?: OrderRecordRow[];
  total?: number;
  page?: number;
  pageSize?: number;
}

function compactOrder(o: OrderRecordRow) {
  return {
    billNo: o.billNo,
    customerName: o.customerName,
    salesPerson: o.salesPerson,
    orderDate: o.orderDate,
    deliveryDate: o.deliveryDate,
    productType: o.productType,
    materials: o.materials,
    quantity: o.quantity,
    unitPrice: o.unitPrice,
    currency: o.currency,
    totalAmount: o.totalAmount,
    shipDate: o.shipDate,
    shipNo: o.shipNo,
    invoiceNo: o.invoiceNo,
    country: o.country,
    dataSource: o.dataSource,
    remark: o.remark,
  };
}

function buildQuery(filter: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const listOrderRecordsTool: ToolDefinition = {
  name: "saleshub_list_order_records",
  description:
    "查询当前用户可见的定单记录（销售员只看自己 + 同组成员的记录，管理员/主管看全部）。" +
    "这是销售员日常用的「定单记录」页面数据源（本地表 + ERP 同步），返回工单号、客户、业务员、" +
    "产品类型、物料、数量、单价、币种、金额、发货信息、发票号、备注等。" +
    "支持按关键字（工单号/客户名模糊）、年份、业务员、数据来源过滤，并返回总数（total）。" +
    "用于回答「我的定单有哪些」「某客户的定单」「某年/某业务员的定单」「工单 xx 的详情」等问题。" +
    "**注意：本工具单页最多返回 100 条，返回 total 但不对全量分页续拉；不要为凑齐全量而连续翻页。**" +
    "当 total 远超单页上限（如按客户/按年汇总全量）时，请遵守「大结果集与全量查询纪律」：先收窄口径（指定客户/时间段/业务员，或看 Top N/统计），多用 chart/cards 呈现，并如实说明覆盖范围。",
  parameters: z.object({
    keyword: z.string().optional().describe("关键字，模糊匹配工单号或客户名"),
    year: z.number().optional().describe("订单年份，如 2026"),
    salesPerson: z.string().optional().describe("业务员姓名，精确匹配"),
    dataSource: z.string().optional().describe("数据来源（如 ERP、手工录入等）"),
    page: z.number().optional().describe("页码，默认 1"),
    pageSize: z.number().optional().describe("每页条数，默认 50,最大 100"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const size = Math.min(100, Math.max(1, args.pageSize || 50));
    const qs = buildQuery({
      keyword: args.keyword,
      year: args.year,
      salesPerson: args.salesPerson,
      dataSource: args.dataSource,
      page: args.page || 1,
      pageSize: size,
    });
    const resp = await hubFetch<OrderRecordsResponse>(ctx, `/api/order-records${qs}`);
    const list = (Array.isArray(resp.data) ? resp.data : []).map(compactOrder);
    return {
      total: resp.total ?? list.length,
      count: list.length,
      records: list,
      page: resp.page ?? 1,
      pageSize: resp.pageSize ?? size,
    };
  },
};

export const orderRecordDetailTool: ToolDefinition = {
  name: "saleshub_order_record_detail",
  description:
    "查询单个定单记录的完整详情，含该项的收款计划（receiptSchedules）。" +
    "参数传工单号（billNo，如 24CMRD1224）。用于回答「某工单的收款计划」「各期款什么时候到、金额多少」等问题。",
  parameters: z.object({
    billNo: z.string().describe("工单号/定单号，精确匹配，如 24CMRD1224"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const record = await hubFetch<any>(ctx, `/api/order-records/${encodeURIComponent(args.billNo)}`);
    const data = record?.data ?? record;
    if (!data || !data.billNo) {
      return { ok: false, message: `未找到定单记录 ${args.billNo}，或无权访问` };
    }
    return {
      record: compactOrder(data),
      receiptSchedules: Array.isArray(data.receiptSchedules) ? data.receiptSchedules : [],
    };
  },
};
