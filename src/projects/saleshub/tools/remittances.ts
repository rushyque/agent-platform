import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { hubFetch, type SalesContext } from "./helpers.js";

// saleshub /api/remittance/query 返回契约（阶段1已实现：服务端过滤/分页/聚合）
interface QueryItem {
  id: number;
  date: string;
  bank?: string;
  method?: string;
  company?: string;
  amount?: string | number;
  currency?: string;
  fee?: string | number | null;
  sales?: string | null;
  bizNo?: string | null;
  publishedAt?: string;
  status: string;
  rejectReason?: string | null;
}

interface QueryResponse {
  total: number;
  offset: number;
  limit: number;
  items: QueryItem[];
  byStatus: {
    status: Record<string, number>;
    amountByStatus: Record<string, number>;
  };
}

interface StatsBucket {
  key: string;
  count: number;
  amount: number | null;
  amountForeign?: number | null;
}

interface StatsResponse {
  scope: { startDate: string | null; endDate: string | null; groupBy: string };
  total: number;
  buckets: StatsBucket[];
}

function buildQuery(
  filter: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const listRemittancesTool: ToolDefinition = {
  name: "saleshub_list_remittances",
  description:
    "分页查询当前登录人可见的汇款/收款记录明细（待填写 pending、已填写 filled、被驳回 rejected、已审核 approved 各状态；不含草稿）。" +
    "**服务端过滤**：支持按日期范围（startDate/endDate，YYYY-MM-DD，按记录日期 receipt_date 含两端）、状态、客户公司（模糊）、销售员（主管可指定他人，销售员固定只看自己）过滤。" +
    "返回结构：`total`（该过滤口径下的**命中总数**，不受分页影响）+ `byStatus`（各状态笔数与金额，基于同一口径全量计算）+ `items`（仅当前页明细）。" +
    "分页用 offset/limit（默认 0/50，limit 上限 200）。返回体自带 footer（Showing N-M of T）。\n" +
    "**取数纪律**：\n" +
    "- 只要\"多少笔/按状态/按客户/按月汇总\"这类统计口径 → 改用 `saleshub_remittance_stats`，一次取全分组，不要用本工具拉明细自己加总。\n" +
    "- 本工具返回的 items 只是当前页；`total` 才是口径全量。**绝不把首页 items 当作全量**，也**绝不连续翻页硬拉全量**（除非用户明确要求且页数很少）。\n" +
    "- 不传任何过滤参数 = 全部历史（total 是历史累计，不是\"本月\"）。回答\"本月/最近\"类问题必须显式传 startDate/endDate。",
  parameters: z.object({
    startDate: z.string().optional().describe("记录日期起（含），YYYY-MM-DD"),
    endDate: z.string().optional().describe("记录日期止（含），YYYY-MM-DD"),
    status: z.enum(["pending", "filled", "rejected", "approved"]).optional().describe("按当前状态过滤"),
    customer: z.string().optional().describe("客户公司名，模糊匹配"),
    salesPerson: z.string().optional().describe("销售员姓名（仅主管/管理员可指定他人）"),
    offset: z.number().optional().describe("偏移量，默认 0；续取下一页时传 offset=N"),
    limit: z.number().optional().describe("每页条数，默认 50，上限 200"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const limit = Math.min(200, Math.max(1, args.limit || 50));
    const offset = Math.max(0, args.offset || 0);
    const qs = buildQuery({
      startDate: args.startDate,
      endDate: args.endDate,
      status: args.status,
      customer: args.customer,
      salesperson: args.salesPerson,
      offset,
      limit,
    });
    const resp = await hubFetch<QueryResponse>(ctx, `/api/remittance/query${qs}`);
    const items = (resp.items || []).map((r) => ({
      id: r.id,
      date: r.date,
      bank: r.bank,
      method: r.method,
      company: r.company,
      amount: r.amount,
      currency: r.currency,
      fee: r.fee,
      sales: r.sales,
      status: r.status,
      rejectReason: r.rejectReason,
    }));
    const from = resp.total === 0 ? 0 : offset + 1;
    const to = offset + items.length;
    return {
      total: resp.total,
      count: items.length,
      byStatus: resp.byStatus,
      items,
      pagination: {
        offset: resp.offset,
        limit: resp.limit,
        hasMore: to < resp.total,
        footer: `Showing ${from}-${to} of ${resp.total}. ${
          to < resp.total ? `Use offset=${to} to continue.` : "This is the full set."
        }`,
      },
    };
  },
};

export const remittanceStatsTool: ToolDefinition = {
  name: "saleshub_remittance_stats",
  description:
    "汇款/收款记录**聚合统计**（不含草稿）：按状态（status）/客户公司（customer）/月份（month）分组，返回每组笔数与金额，一次调用取全部分组，无需翻页。" +
    "支持日期范围（startDate/endDate，YYYY-MM-DD）与客户过滤；`scope` 会回显本次统计口径（日期范围 + groupBy），回答时必须带上口径，防止把部分当全量。\n" +
    "**优先用本工具回答**：「这个月有多少汇款」「总共多少笔」「按状态拆分」「本月各客户到账」「按月份趋势」等一切统计/汇总类问题。" +
    "注意：`amount` 为人民币口径金额（仅 CNY/RMB 币种），`amountForeign` 为非人民币币种的原始金额合计（**未折算**，USD/HKD 等混币种直接相加仅作量级参考）。回答金额时优先引用明细的单币种金额；用 amountForeign 汇报时必须注明\"未折算的外币合计\"。需要明细时才改用 `saleshub_list_remittances`（分页）。",
  parameters: z.object({
    startDate: z.string().optional().describe("记录日期起（含），YYYY-MM-DD"),
    endDate: z.string().optional().describe("记录日期止（含），YYYY-MM-DD"),
    customer: z.string().optional().describe("客户公司名，模糊匹配"),
    salesPerson: z.string().optional().describe("销售员姓名（仅主管/管理员可指定他人）"),
    groupBy: z.enum(["status", "customer", "month"]).optional().describe("分组维度，默认 status"),
  }),
  readonly: true,
  execute: async (args, context) => {
    const ctx = context as SalesContext;
    const qs = buildQuery({
      startDate: args.startDate,
      endDate: args.endDate,
      customer: args.customer,
      salesperson: args.salesPerson,
      groupBy: args.groupBy || "status",
    });
    const resp = await hubFetch<StatsResponse>(ctx, `/api/remittance/stats${qs}`);
    return {
      scope: resp.scope,
      total: resp.total,
      bucketCount: (resp.buckets || []).length,
      buckets: resp.buckets || [],
      note: "统计口径见 scope；amount 为人民币口径（CNY/RMB），amountForeign 为未折算的外币合计（注明币种构成）。需要明细时用 saleshub_list_remittances 分页查询。",
    };
  },
};
