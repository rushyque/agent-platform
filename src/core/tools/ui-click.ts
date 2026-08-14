import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";
import type { UIActionRegistryEntry } from "../ui-actions/types.js";
import {
  computeEffectiveDone,
  isEntrySatisfied,
  normalizePage,
} from "../ui-actions/effective.js";

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

export type { UIActionRegistryEntry } from "../ui-actions/types.js";

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

/** 通用前置校验：动作声明了 after（需先做的前置动作 id）时，检查本轮是否已执行过全部前置。 */
function afterViolation(
  entry: UIActionRegistryEntry,
  effectiveDone: Set<string>
): string | null {
  if (!entry.after || entry.after.length === 0) return null;
  const missing = entry.after.filter((id) => !effectiveDone.has(id));
  if (missing.length === 0) return null;
  return (
    `Action "${entry.label}" 有前置依赖，需先依次完成：【${missing.join("、")}】` +
    `。请先用 ui_click/ui_fill 触发这些前置动作再执行本动作，不要跳步。`
  );
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
    // 通用顺序前置校验（基于协议字段 after，与业务无关）。用"生效前置集合"
    // （含已在目标页天然满足的入口动作）判定，与 ui_fill / get_page_state 口径一致。
    const effectiveDone = computeEffectiveDone(
      actions,
      (context as any).executedUiActions ?? [],
      (context as any).currentPage
    );
    const violated = afterViolation(entry, effectiveDone);
    if (violated) {
      return {
        ok: false,
        ui: { type: "click", id, valid: false },
        hint: violated,
      };
    }
    // 模型传的 risk 若与清单不符，以清单为准（前端硬闸门仍会再兜底一次）。
    const risk = entry.risk;
    const mode = modeCopy((context as any).chatMode);
    const currentPage = (context as any).currentPage as string | undefined;

    // 通用防回跳：入口动作的目标页已到达时，再点入口只会切走已填好/已进入的页。
    // 直接拒绝并给出明确指引，避免模型"以为没进入、回列表页重触发入口"的绕圈。
    if (entry.entry && isEntrySatisfied(entry, currentPage || "")) {
      return {
        ok: false,
        ui: { type: "click", id, valid: false },
        hint:
          `Action "${entry.label}" 是入口动作，而当前已在它的目标页 ${normalizePage(currentPage || "")}，` +
          "入口已满足：不必再点击该入口，也不要导航回列表页重触发。请直接继续填写/提交当前页的动作。",
      };
    }

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

    // 页面跟踪：入口/跳转类动作返回其目标页（entry.to 优先），否则用登记页本身，
    // 供 server.ts 更新 context.currentPage，让 get_page_state 读到"执行后落在哪一页"。
    const pageAfter = entry.entry && entry.to ? entry.to : entry.page;
    return {
      ok: true,
      ui: { type: "click", id: entry.id, label: entry.label, page: pageAfter, risk },
      hint: `Click "${entry.label}" (${riskText(risk)})`,
    };
  },
};

// 便捷导出（需 opt-in）
export const uiInteractionTools: ToolDefinition[] = [uiClickTool];
