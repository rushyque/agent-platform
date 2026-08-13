import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";

// 平台级"前端动作触发"工具（ui_click）。
//
// 与 show_ui 同一套思路：中台工具本身是 no-op，返回结构化 UI 指令 {ui:{type,...}}，
// 由前端在 TOOL_CALL_RESULT / 调用参数里解析并执行真实 DOM 动作。中台只定公共契约，
// 不关心具体平台细节，任何接入项目都能复用。
//
// 安全模型：可用动作清单（含 risk 标注）由前端经请求头 x-ui-actions 上报，平台在
// resolveContext 后注入 context.uiActions。工具据此校验目标 id 与 risk：
//   - risk=none      → 只读/无副作用动作，前端直接执行；
//   - risk=mutating  → 有副作用动作，前端必须弹确认闸门，用户确认后才执行；
//   - risk=critical  → 关键/提交类动作，前端不直接触发，改为高亮推荐按钮区域诱导用户亲自点击。
//
// 对话模式（context.chatMode，前端经 X-Chat-Mode 头上报）决定本工具的行为口径：
//   - browse 浏览模式：不操作前端页面（工具在 server.ts 里按模式裁剪，正常不会走到这里）；
//   - act    行动模式：只读动作直接执行，mutating/critical 一律转为"命令通过"确认指令，
//                      由前端渲染确认卡片让用户通过/驳回，不中断对话、不用系统弹窗；
//   - full   完全模式：只读 + mutating 直接执行，critical 不触发事件，改为高亮推荐操作诱导用户。
// 模型看到的是"标注了风险的动作清单"，它选择 id，是否放行由前端硬闸门兜底。

export interface UIActionRegistryEntry {
  id: string;
  label: string;
  page: string; // route path 所在的页面，如 /visit-plans
  risk: "none" | "mutating" | "critical";
  kind?: "button" | "input" | "select" | "textarea"; // 缺省视为 button
}

const RISK = z.enum(["none", "mutating", "critical"]);
const MODE = z.enum(["browse", "act", "full"]).optional();

function modeCopy(mode: string | undefined): string {
  return mode === "full" ? "full" : mode === "browse" ? "browse" : "act";
}

function riskText(risk: string): string {
  if (risk === "critical") return "关键操作(critical, 前端高亮诱导用户点击, 不自动触发)";
  if (risk === "mutating") return "有副作用(mutating, 行动模式需用户通过)";
  return "只读(none)";
}

export const uiClickTool: ToolDefinition = {
  name: "ui_click",
  description:
    "触发当前系统注册好的一个页面动作（点击某个按钮/执行某项操作）。" +
    "可用动作由当前系统提供并标注风险：risk=none 为只读/无副作用、直接执行；risk=mutating 为有副作用、行动模式会先请用户通过；risk=critical 为关键/提交类、行动模式请用户通过、完全模式改为高亮诱导用户亲自点击。" +
    "调用时传动作 id，id 必须是系统提供的可用动作之一，不要臆造。",
  parameters: z.object({
    id: z.string().describe("要触发的动作 id（来自系统提供的可用动作清单）"),
    risk: RISK.optional().describe("该动作的风险标注（与清单一致，供校验）"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const id = String(args && args.id || "");
    if (!id) {
      return { ok: false, ui: { type: "click", id: "", valid: false }, hint: "Missing action id." };
    }
    const actions = (context as any).uiActions as UIActionRegistryEntry[] | undefined;
    const entry = actions?.find((a) => a.id === id);
    if (!entry) {
      return {
        ok: false,
        ui: { type: "click", id, valid: false },
        hint:
          "Action '" + id + "' not in the current system's registered actions. Available: " +
          (actions?.map((a) => a.id).join(", ") || "(none)"),
      };
    }
    // 输入项（kind=input/select/textarea）不是"点击动作"，应由 ui_fill 填写而非 ui_click 触发。
    if (entry.kind && entry.kind !== "button") {
      return {
        ok: false,
        ui: { type: "click", id, valid: false },
        hint: `Action "${entry.label}" is an input field (kind=${entry.kind}); use ui_fill to set its value instead of ui_click.`,
      };
    }
    // 模型传的 risk 若与清单不符，以清单为准（前端硬闸门仍会再兜底一次）。
    const risk = entry.risk;
    const mode = modeCopy((context as any).chatMode);

    // 行动模式：mutating / critical 不直接执行，转为"命令通过"确认指令，由前端渲染卡片。
    if (mode === "act" && risk !== "none") {
      return {
        ok: false,
        pending: true,
        ui: {
          type: "confirm_click",
          id: entry.id,
          label: entry.label,
          page: entry.page,
          risk,
          reason: risk === "critical"
            ? "这是关键/提交操作，先请你确认是否执行"
            : "该操作有副作用，先请你确认是否执行",
        },
        hint: `Action "${entry.label}" needs approval (mode=act, risk=${risk}). Front-end will ask the user to pass or block.`,
      };
    }

    // 完全模式：critical 不触发事件，改为高亮推荐操作诱导用户亲自点击。
    if (mode === "full" && risk === "critical") {
      return {
        ok: false,
        pending: true,
        ui: {
          type: "highlight_actions",
          ids: [entry.id],
          label: entry.label,
          page: entry.page,
          reason: "这是关键操作，已高亮推荐按钮，请你在页面上手动确认",
        },
        hint: `Action "${entry.label}" is critical; front-end highlights recommended button(s) instead of auto-clicking.`,
      };
    }

    return {
      ok: true,
      ui: { type: "click", id: entry.id, label: entry.label, page: entry.page, risk },
      hint: `Click "${entry.label}" (${riskText(risk)})`,
    };
  },
};

// 便捷导出（需 opt-in）
export const uiInteractionTools: ToolDefinition[] = [uiClickTool];
