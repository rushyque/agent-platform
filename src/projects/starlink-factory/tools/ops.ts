// factory -- resource-based tool (replaces 10 flat tools)
// Modes: dashboard / shift_report / advance / advance_batch / events / handle_event / tech / research / pipeline / reset
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState, resetGameState } from "../game/state-store.js";
import { advanceShift, advanceShifts, handleEvent, research, runPipeline } from "../game/engine.js";
import { emitGameEvent } from "../game/game-bus.js";
import { EVENT_TYPE_LABEL } from "../game/types.js";
import { TECH_TREE, TECH_NODE, TECH_CATEGORY_LABEL, nodeStatus } from "../game/tech.js";
import { dashboardSummary, shiftReportSummary } from "./views.js";

export const factoryTool: ToolDefinition = {
  name: "factory_ops",
  description:
    "Factory operations (run the business). Modes:\n" +
    "- dashboard: overall health (shift/cash/reputation/machines/orders/events).\n" +
    "- shift_report: recent N shifts income & expense breakdown.\n" +
    "- advance: advance 1 shift (core progress: machining, events, inquiries).\n" +
    "- advance_batch: advance 1-12 shifts at once (use for multi-shift instructions).\n" +
    "- events: list all events (active + resolved).\n" +
    "- handle_event: resolve an event (choice: repair/ignore/accept/decline/expedite/wait/apologize).\n" +
    "- tech: view tech tree (status/cost/prerequisites/effects).\n" +
    "- research: start a tech research (deducts cash, progresses per shift).\n" +
    "- pipeline: one-click combo: accept all inquiries + design all + schedule all + optionally advance N shifts.\n" +
    "- reset: wipe progress, start fresh.",
  parameters: z.object({
    mode: z
      .enum(["dashboard", "shift_report", "advance", "advance_batch", "events", "handle_event", "tech", "research", "pipeline", "reset"])
      .describe("Factory action"),
    lastShifts: z.number().int().min(1).max(20).optional().describe("[shift_report] Recent shifts to report, default 6"),
    count: z.number().int().min(1).max(12).optional().describe("[advance_batch] Shifts to advance (1-12)"),
    eventId: z.string().optional().describe("[handle_event] Event id to resolve"),
    choice: z
      .string()
      .optional()
      .describe("[handle_event] Choice: repair/ignore/accept/decline/expedite/wait/apologize"),
    nodeId: z.string().optional().describe("[research] Tech node id, e.g. lean/cnc_upgrade/qms"),
    pipelineShifts: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe("[pipeline] Shifts to advance after scheduling (0=schedule only)"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);

    if (args.mode === "dashboard") return dashboardSummary(state);

    if (args.mode === "shift_report") return shiftReportSummary(state, args.lastShifts ?? 6);

    if (args.mode === "advance") return advanceShift(state);

    if (args.mode === "advance_batch") return advanceShifts(state, args.count ?? 1);

    if (args.mode === "events") {
      return {
        events: state.events.map((e) => ({
          id: e.id,
          type: EVENT_TYPE_LABEL[e.type],
          title: e.title,
          detail: e.detail,
          resolved: e.resolved,
          payload: e.payload,
        })),
      };
    }

    if (args.mode === "handle_event") {
      return handleEvent(state, args.eventId!, args.choice!);
    }

    if (args.mode === "tech") {
      const researching = state.tech.researching;
      const byCategory: Record<string, any[]> = {};
      for (const node of TECH_TREE) {
        const st = nodeStatus(state, node.id);
        byCategory[node.category] = byCategory[node.category] ?? [];
        byCategory[node.category].push({
          id: node.id,
          name: node.name,
          category: TECH_CATEGORY_LABEL[node.category],
          status: st,
          cost: node.cost,
          researchShifts: node.researchShifts,
          requires: node.requires.map((r) => TECH_NODE[r]?.name ?? r),
          desc: node.desc,
          progress:
            st === "researching" && researching
              ? `${researching.total - researching.remaining}/${researching.total} shifts`
              : undefined,
        });
      }
      return {
        researchedCount: state.tech.researched.length,
        researching: researching
          ? {
              name: TECH_NODE[researching.nodeId]?.name ?? researching.nodeId,
              progress: `${researching.total - researching.remaining}/${researching.total} shifts`,
            }
          : null,
        tree: byCategory,
      };
    }

    if (args.mode === "research") return research(state, args.nodeId!);

    if (args.mode === "pipeline") {
      return runPipeline(state, { advanceShifts: args.pipelineShifts ?? 0 });
    }

    if (args.mode === "reset") {
      const fresh = resetGameState(context.userId);
      emitGameEvent(context.userId, {
        kind: "reset",
        summary: "Game reset",
        snapshot: JSON.parse(JSON.stringify(fresh)),
      });
      return { ok: true, message: "Factory reset complete." };
    }

    return { ok: false, message: "Unknown mode: " + args.mode };
  },
};
