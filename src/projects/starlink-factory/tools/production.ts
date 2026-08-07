// production -- resource-based tool (replaces 4 flat tools)
// Modes: design / schedule / unschedule / trial
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState } from "../game/state-store.js";
import { startDesign, scheduleJob, unscheduleJob, runTrial } from "../game/engine.js";

export const productionTool: ToolDefinition = {
  name: "factory_production",
  description:
    "Production operations on accepted orders. Modes:\n" +
    "- design: create mold design (process route, steel grade, design quality). Order must be 'accepted'.\n" +
    "- schedule: assign the next process step to a machine (auto-picks if machineId omitted).\n" +
    "- unschedule: cancel the current machining step, free the machine.\n" +
    "- trial: trial-run a finished order (must be '待试模' and trial machine free).",
  parameters: z.object({
    mode: z.enum(["design", "schedule", "unschedule", "trial"]).describe("Production action"),
    orderId: z.string().describe("Order id, e.g. O-0001"),
    machineId: z
      .string()
      .optional()
      .describe("[schedule] Specify machine id (e.g. M-CNC-02); omit for auto-assign"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);

    if (args.mode === "design") return startDesign(state, args.orderId);
    if (args.mode === "schedule") return scheduleJob(state, args.orderId, args.machineId);
    if (args.mode === "unschedule") return unscheduleJob(state, args.orderId);
    if (args.mode === "trial") return runTrial(state, args.orderId);

    return { ok: false, message: "Unknown mode: " + args.mode };
  },
};
