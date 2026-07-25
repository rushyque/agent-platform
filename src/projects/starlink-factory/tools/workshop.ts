// 车间工具：看板 / 排程 / 库存 / 采购
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState } from "../game/state-store.js";
import { purchaseMaterial } from "../game/engine.js";
import { MACHINE_TYPE_LABEL, PROCESS_LABEL, STEEL_PRICE } from "../game/types.js";

export const viewWorkshopTool: ToolDefinition = {
  name: "factory_view_workshop",
  description:
    "查看车间看板：所有机床（CNC加工中心/EDM火花机/线切割/试模注塑机）的实时状态（空闲/运行中/故障/维护）、速度系数、当前承接订单、剩余/总班次进度。这是排产决策的主要依据。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
    return {
      machines: state.machines.map((m) => ({
        id: m.id,
        name: m.name,
        type: MACHINE_TYPE_LABEL[m.type],
        status: m.status,
        speed: m.speed,
        orderId: m.orderId,
        remaining: m.remaining,
        total: m.total,
        progress: m.total ? `${m.total - (m.remaining ?? 0)}/${m.total}` : undefined,
      })),
    };
  },
};

export const viewScheduleTool: ToolDefinition = {
  name: "factory_view_schedule",
  description: "查看在制排程：每台运行中机床上的订单、工序、剩余班次；以及所有订单下一道待加工工序，便于规划下一步排产。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
    const running = state.machines
      .filter((m) => m.status === "running")
      .map((m) => {
        const order = m.orderId ? state.orders.find((o) => o.id === m.orderId) : undefined;
        const step = order?.steps.find((s) => s.machineId === m.id && s.status === "running");
        return {
          machine: m.name,
          orderId: m.orderId,
          process: step ? PROCESS_LABEL[step.process] : undefined,
          remaining: m.remaining,
          total: m.total,
        };
      });
    const pending = state.orders
      .filter((o) => o.status === "ready" || o.status === "in_production")
      .map((o) => {
        const next = o.steps.find((s) => s.status === "pending");
        return next ? { orderId: o.id, customer: o.customer, nextProcess: PROCESS_LABEL[next.process] } : null;
      })
      .filter(Boolean);
    return { running, pendingNext: pending };
  },
};

export const viewInventoryTool: ToolDefinition = {
  name: "factory_view_inventory",
  description: "查看模具钢料库存：各牌号（P20/718H/S136）库存块数与单价。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
    return {
      cash: state.cash,
      inventory: state.inventory.map((i) => ({ grade: i.grade, qty: i.qty, unitPrice: STEEL_PRICE[i.grade] ?? null })),
    };
  },
};

export const purchaseMaterialTool: ToolDefinition = {
  name: "factory_purchase_material",
  description: "采购模具钢料。牌号：P20(¥1800/块) / 718H(¥3200/块) / S136(¥5200/块)。扣现金、加库存，即时到货。",
  parameters: z.object({
    grade: z.enum(["P20", "718H", "S136"]).describe("钢料牌号"),
    qty: z.number().int().positive().describe("采购块数"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return purchaseMaterial(state, args.grade, args.qty);
  },
};
