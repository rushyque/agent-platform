import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";
import type { UIActionRegistryEntry } from "../ui-actions/types.js";
import { computeEffectiveDone, normalizePage } from "../ui-actions/effective.js";

// get_page_state —— 在执行页面动作前读取"当前页面状态"（只读）。
//
// 与 ui_click / ui_fill 配合：这两个工具由模型发起、由前端执行（中台工具本身是
// no-op，只返回结构化指令）。模型多步编排时容易"不知道自己现在在哪一页、该页
// 哪些动作可用、哪些已做过"，从而跳步或重复操作。本工具让模型在动手前先确认：
//   - 当前所在页（前端上报的实际路由，或本轮 navigate/ui 动作后跟踪到的页）；
//   - 该页可用的动作与风险标注；
//   - 本轮已执行过的动作 id（after 前置校验依据）；
//   - 还没满足前置、还不能调用的动作。
//
// 平台级、通用：只依赖 context.uiActions / context.currentPage /
// context.executedUiActions 这三个平台约定字段，不绑定任何业务。任何接入系统只要
// 按"动作清单带 page + 前端上报当前页"的协议上报，即可复用本工具，无需为中台做特化。

/** 判断某动作的登记页是否属于/覆盖当前页（支持模块子路由复用清单）。 */
function actionMatchesPage(entryPage: string, currentPage: string): boolean {
  const ep = normalizePage(entryPage);
  const cp = normalizePage(currentPage);
  if (ep === cp) return true;
  // 模块级登记页（如 /inquiries）覆盖其全部子路由（/inquiries/new、/inquiries/:id）。
  if (cp.startsWith(ep + "/")) return true;
  if (cp.startsWith("/inquiries") && ep.startsWith("/inquiries")) return true;
  return false;
}

export const getPageStateTool: ToolDefinition = {
  name: "get_page_state",
  description:
    "在执行页面动作之前，先读取当前页面状态（只读）：" +
    "返回当前所在页、该页可用的已注册动作（含风险标注）、本轮已执行过哪些动作、" +
    "以及哪些动作因前置未满足还不能调用。多步操作（跳转→填表→提交）时，先调用本工具确认当前页与可用动作，再决定下一步，避免跳步或对不存在的元素" +
    "空操作。",
  parameters: z.object({
    page: z
      .string()
      .optional()
      .describe("可选：指定要查询的页面（如 '/inquiries'），不传则返回当前所在页的状态"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const queryPage = args && typeof args.page === "string" ? args.page.trim() : "";
    const actions = (context as any).uiActions as UIActionRegistryEntry[] | undefined;
    const allActions = Array.isArray(actions) ? actions : [];
    const rawDone = new Set<string>((context as any).executedUiActions ?? []);
    const currentPage = normalizePage(
      queryPage || (context as any).currentPage || ""
    );

    // 统一的"生效已完成"集合（含当前页天然满足的入口动作）——与 ui_fill / ui_click
    // 的 after 校验完全同口径。available_actions / done_actions / blocked_actions
    // 全部基于它计算，杜绝"入口显示 done 但 done 集合为空"的自相矛盾误导模型绕圈。
    const effectiveDone = computeEffectiveDone(
      allActions,
      rawDone,
      currentPage
    );

    const available = allActions
      .filter((a) => actionMatchesPage(a.page, currentPage))
      .map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind ?? "button",
        risk: a.risk,
        done: effectiveDone.has(a.id),
        entry: !!a.entry,
        step: a.step,
        after: a.after ?? [],
        options: a.options,
        desc: a.desc,
      }))
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return String(a.step || "").localeCompare(String(b.step || ""));
      });

    const blocked: Record<string, string[]> = {};
    for (const a of allActions) {
      if (a.after && a.after.length > 0) {
        const missing = a.after.filter((id) => !effectiveDone.has(id));
        if (missing.length > 0) blocked[a.id] = missing;
      }
    }

    return {
      ok: true,
      ui: { type: "page_state", page: currentPage || "unknown" },
      page: currentPage || "unknown",
      available_actions: available,
      done_actions: Array.from(effectiveDone),
      blocked_actions: blocked,
      hint: queryPage
        ? `Page state for ${currentPage || "unknown"}`
        : `Current page: ${currentPage || "unknown"}`,
    };
  },
};
