// 运营工具：仪表盘 / 推进班次 / 事件列表 / 处理事件 / 重置
import { z } from "zod";
import type { ToolDefinition } from "../../../types/agent-config.js";
import { getGameState, resetGameState } from "../game/state-store.js";
import { advanceShift, advanceShifts, handleEvent, research, runPipeline } from "../game/engine.js";
import { emitGameEvent } from "../game/game-bus.js";
import { EVENT_TYPE_LABEL } from "../game/types.js";
import { TECH_TREE, TECH_NODE, TECH_CATEGORY_LABEL, nodeStatus } from "../game/tech.js";
import { dashboardSummary } from "./views.js";

export const viewDashboardTool: ToolDefinition = {
  name: "factory_view_dashboard",
  description:
    "查看工厂经营仪表盘：当前班次、现金、声誉(0-100)、各状态机床数量、订单按状态分布、待处理事件数、是否破产。是了解全局健康度的入口。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
    return dashboardSummary(state);
  },
};

export const advanceShiftTool: ToolDefinition = {
  name: "factory_advance_shift",
  description:
    "推进一个班次（核心推进器）：所有运行中机床工时-1，工序完成的记录质量分并释放机床、若订单工序全部完成则进入「待试模」；结算逾期罚金（仅一次）、扣固定开支、可能触发随机事件（设备故障/紧急插单/钢料延迟/客户催货）、可能新增询价单。现金<0 即破产。返回本班次完成事项与最新现金/声誉。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
    return advanceShift(state);
  },
};

export const advanceShiftsTool: ToolDefinition = {
  name: "factory_advance_shifts",
  description:
    "一次性连续推进多个班次（批量版 advance_shift，强烈推荐用于多班次指令）。循环推进 1-12 个班次，聚合所有完成工序/交付/事件/科技进度/破产为一条结果，只触发一次状态更新。老板要求\"推进 N 个班次/连续运行/管 6 个班次\"时必须用本工具一次性完成，不要逐班调用 factory_advance_shift。",
  parameters: z.object({
    count: z.number().int().min(1).max(12).describe("连续推进的班次数，1-12"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return advanceShifts(state, args.count);
  },
};

export const listTechTool: ToolDefinition = {
  name: "factory_list_tech",
  description:
    "查看科技与升级树：按 工艺/设备/质量/管理 四类列出全部节点，每个节点含状态(researched已研发/researching研究中/available可研发/locked前置未满足)、投入、所需班次、前置、效果、当前研究进度。是规划长期成长的入口。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
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
            ? `${researching.total - researching.remaining}/${researching.total} 班次`
            : undefined,
      });
    }
    return {
      researchedCount: state.tech.researched.length,
      researching: researching
        ? {
            name: TECH_NODE[researching.nodeId]?.name ?? researching.nodeId,
            progress: `${researching.total - researching.remaining}/${researching.total} 班次`,
          }
        : null,
      tree: byCategory,
    };
  },
};

export const researchTool: ToolDefinition = {
  name: "factory_research",
  description:
    "启动一项科技研发。扣投入现金、进入\"研究中\"，每推进一个班次（factory_advance_shift / factory_advance_shifts）累计进度，完成后效果永久生效。需满足前置科技、现金足够、且当前没有其它在研项目。用 factory_list_tech 查可研发项。",
  parameters: z.object({
    nodeId: z.string().describe("要研发的科技节点 id，如 lean / cnc_upgrade / qms"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return research(state, args.nodeId);
  },
};

export const runPipelineTool: ToolDefinition = {
  name: "factory_run_pipeline",
  description:
    "一键流水线（强烈推荐用于组合指令）：自动接下所有询价单 → 全部出设计 → 把待排产订单的下一道工序排到空闲机床（自动匹配机床类型/缺料会跳过并提示）。advanceShifts 传 N 则排产后继续连续推进 N 个班次（会结算工序完成/交付/事件/科技）。用于\"接单排产\"、\"开始运营\"、\"接单并推进N班\"、\"全力生产\"等组合指令——一次调用完成，禁止拆成多个 accept/design/schedule 逐个调用、更禁止只口头描述不调用。",
  parameters: z.object({
    advanceShifts: z
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe("排产后连续推进的班次数（0-12）。不传或 0 = 只接单设计排产，不推进时间"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return runPipeline(state, { advanceShifts: args.advanceShifts ?? 0 });
  },
};

export const listEventsTool: ToolDefinition = {
  name: "factory_list_events",
  description: "列出当前所有事件（含已处理与待处理）。每个事件含类型、标题、详情、是否已处理、附带数据（如故障机床/相关订单）。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = getGameState(context.userId);
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
  },
};

export const handleEventTool: ToolDefinition = {
  name: "factory_handle_event",
  description:
    "处理一个待处理事件。各类型可选 choice：设备故障→repair(花钱维修恢复)/ignore(保持故障)；紧急插单→accept(接下加急单)/decline(拒单声誉-1)；钢料延迟→expedite(加急¥8000)/wait(库存-10)；客户催货→apologize(安抚声誉-2)/ignore(无视声誉-4)。",
  parameters: z.object({
    eventId: z.string().describe("要处理的事件 id"),
    choice: z.string().describe("处理选项，如 repair / ignore / accept / decline / expedite / wait / apologize"),
  }),
  execute: async (args, context) => {
    const state = getGameState(context.userId);
    return handleEvent(state, args.eventId, args.choice);
  },
};

export const resetGameTool: ToolDefinition = {
  name: "factory_reset",
  description: "重置游戏：清空当前进度，回到初始工厂状态（全新询价单与库存）。仅在老板要求重新开始时使用。",
  parameters: z.object({}),
  execute: async (_args, context) => {
    const state = resetGameState(context.userId);
    emitGameEvent(context.userId, {
      kind: "reset",
      summary: "游戏已重置",
      snapshot: JSON.parse(JSON.stringify(state)),
    });
    return { ok: true, message: "工厂已重置，可以重新开工。" };
  },
};
