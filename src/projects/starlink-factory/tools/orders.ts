// order -- resource-based tool (replaces 4 flat tools)
// Modes: list / detail / accept / deliver
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState } from "../game/state-store.js";
import { acceptInquiry, deliverOrder } from "../game/engine.js";
import { MOLD_LABEL } from "../game/types.js";
import { summarizeOrder } from "./views.js";

export const orderTool: ToolDefinition = {
  name: "factory_order",
  description:
    "Order operations. Modes:\n" +
    "- list: list all orders (optional status filter). Returns id/customer/type/qty/price/due/status/progress.\n" +
    "- detail: full order detail (process steps, steel, quality, trial result).\n" +
    "- accept: accept an inquiry order into production.\n" +
    "- deliver: deliver a trial-passed order (payment + reputation).",
  parameters: z.object({
    mode: z.enum(["list", "detail", "accept", "deliver"]).describe("Order action"),
    orderId: z.string().optional().describe("[detail/accept/deliver] Order id, e.g. O-0001"),
    status: z
      .string()
      .optional()
      .describe("[list] Status filter, e.g. '待排产' / '加工中'. Omit for all."),
  }),
  readonly: true,
  execute: async (args, context) => {
    const state = getGameState(context.userId);

    if (args.mode === "list") {
      const all = state.orders.map(summarizeOrder);
      const list = args.status
        ? all.filter((o) => o.status === args.status || o.status.includes(args.status!))
        : all;
      return { count: list.length, orders: list };
    }

    if (args.mode === "detail") {
      const order = state.orders.find((o) => o.id === args.orderId);
      if (!order) return { ok: false, message: `Order ${args.orderId} not found` };
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
    }

    if (args.mode === "accept") {
      return acceptInquiry(state, args.orderId!);
    }

    if (args.mode === "deliver") {
      return deliverOrder(state, args.orderId!);
    }

    return { ok: false, message: "Unknown mode: " + args.mode };
  },
};

export { MOLD_LABEL };
