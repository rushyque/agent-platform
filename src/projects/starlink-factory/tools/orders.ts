// 订单工具：列表 / 详情 / 接单 / 交付
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState } from "../game/state-store.js";
import { acceptInquiry, deliverOrder } from "../game/engine.js";
import { MOLD_LABEL } from "../game/types.js";
import { summarizeOrder } from "./views.js";

export const listOrdersTool: ToolDefinition = {
  name: "factory_list_orders",
  description:
    "列出工厂所有订单。可按状态过滤（询价/已接单/设计中/待排产/加工中/待试模/已交付/逾期）。每个订单返回 id、客户、模具类型、数量、报价、交期班次、状态、进度(完成工序/总工序)、是否紧急单。不传 status 则返回全部。",
  parameters: z.object({
    status: z
      .string()
      .optional()
      .describe("按状态过滤，例如：询价、待排产、加工中。不传返回全部"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    const all = state.orders.map(summarizeOrder);
    const list = args.status
      ? all.filter((o) => o.status === args.status || o.status.includes(args.status!))
      : all;
    return { count: list.length, orders: list };
  },
};

export const orderDetailTool: ToolDefinition = {
  name: "factory_order_detail",
  description: "查询单个订单详情：完整工艺路线、每道工序的状态/所在机床/剩余班次/质量分、钢料需求与是否已投料、试模结果、交期。",
  parameters: z.object({
    orderId: z.string().describe("订单 id，如 O-0001"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    const order = state.orders.find((o) => o.id === args.orderId);
    if (!order) return { ok: false, message: `未找到订单 ${args.orderId}` };
    return {
      summary: summarizeOrder(order),
      steps: order.steps.map((s) => ({
        process: s.process,
        status: s.status,
        machineId: s.machineId,
        remaining: s.remaining,
        total: s.total,
        quality: s.quality,
      })),
      steelGrade: order.steelGrade,
      steelNeeded: order.steelNeeded,
      steelConsumed: order.steelConsumed,
      designQuality: order.designQuality,
      trialPassed: order.trialPassed,
      acceptedAtShift: order.acceptedAtShift,
      dueShift: order.dueShift,
      deliveredAtShift: order.deliveredAtShift,
    };
  },
};

export const acceptInquiryTool: ToolDefinition = {
  name: "factory_accept_inquiry",
  description: "接下一张询价单，进入「已接单」状态。仅询价单可接。接单不收费，交付后才回款。",
  parameters: z.object({
    orderId: z.string().describe("要接的询价单 id"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return acceptInquiry(state, args.orderId);
  },
};

export const deliverOrderTool: ToolDefinition = {
  name: "factory_deliver_order",
  description: "交付已试模合格的订单给客户，回款到账，按时交付加声誉、逾期扣声誉。必须是「待试模」且试模已合格。",
  parameters: z.object({
    orderId: z.string().describe("要交付的订单 id"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return deliverOrder(state, args.orderId);
  },
};

// 供 prompt/其它模块引用
export { MOLD_LABEL };
