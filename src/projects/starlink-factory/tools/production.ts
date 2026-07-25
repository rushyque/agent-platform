// 生产工具：设计 / 排产 / 撤排 / 试模
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState } from "../game/state-store.js";
import { startDesign, scheduleJob, unscheduleJob, runTrial } from "../game/engine.js";

export const startDesignTool: ToolDefinition = {
  name: "factory_start_design",
  description:
    "对「已接单」订单开展模具设计：产出工艺路线（吹瓶模=粗加工CNC→精加工CNC→EDM→抛光→装配；注坯模=精加工CNC→EDM→装配；瓶盖模=精加工CNC→装配）、确定钢料牌号与需求量、给出设计水平分。设计完成后进入「待排产」。抛光/装配为手工工位自动完成，不占机床。",
  parameters: z.object({
    orderId: z.string().describe("要设计的订单 id"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return startDesign(state, args.orderId);
  },
};

export const scheduleJobTool: ToolDefinition = {
  name: "factory_schedule_job",
  description:
    "把订单的下一道待加工工序排上机床。不传 machineId 时自动选一台空闲的合适机床。首个加工工序上料时会一次性扣足该订单所需钢料（库存不足会拒绝，需先采购）。注意机床类型必须匹配工序（CNC加工中心=粗/精加工CNC，EDM火花机=EDM，线切割=线切割）。可重复调用以逐道排产。",
  parameters: z.object({
    orderId: z.string().describe("要排产的订单 id"),
    machineId: z
      .string()
      .optional()
      .describe("指定的机床 id（如 M-CNC-02）；不传则自动分配空闲机床"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return scheduleJob(state, args.orderId, args.machineId);
  },
};

export const unscheduleJobTool: ToolDefinition = {
  name: "factory_unschedule_job",
  description: "取消某订单当前正在机加工的工序，释放机床，工序退回「待排产」。已完成的工序不受影响。",
  parameters: z.object({
    orderId: z.string().describe("要撤排的订单 id"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return unscheduleJob(state, args.orderId);
  },
};

export const runTrialTool: ToolDefinition = {
  name: "factory_run_trial",
  description:
    "对「待试模」订单试模（需试模注塑机空闲）。按工序质量与设计水平判定合格/不合格。合格→可交付；不合格→自动定位质量最低的加工工序返工（退回待排产，需重新排产）。占用试模注塑机。",
  parameters: z.object({
    orderId: z.string().describe("要试模的订单 id"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return runTrial(state, args.orderId);
  },
};
