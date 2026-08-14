import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";
import type { UIActionRegistryEntry } from "../ui-actions/types.js";

// 平台级"前端填表"工具（ui_fill）。
//
// 与 ui_click 同一套思路：中台工具本身是 no-op，返回结构化 UI 指令
// {ui:{type:'fill', id, value}}，由前端解析并在真实输入项上写入 value。
// 只要"可用动作清单"（x-ui-actions）里登记了 kind=input/select/textarea 的项，
// 模型就能用 ui_fill 填表；提交/保存这类最终动作应标 critical，由 ui_click 走
// "高亮诱导用户亲自点击"（完全模式）或"命令通过"（行动模式）。
//
// 安全模型：填表本身不产生后端副作用，risk 必须为 none 才能被本工具使用；
// 关键/有副作用的项一律拒绝由 ui_fill 处理（应走 ui_click 的确认/高亮闸门）。

export type { UIActionRegistryEntry } from "../ui-actions/types.js";

const KIND = z.enum(["input", "select", "textarea"]);

export const uiFillTool: ToolDefinition = {
  name: "ui_fill",
  description:
    "把值写入当前系统注册好的一个输入项（输入框/下拉/多行文本），用于填表。" +
    "可用输入项由当前系统提供（kind=input/select/textarea），id 必须是清单里的一项，不要臆造。" +
    "填表本身无副作用（副作用发生在最终提交动作上），因此提交/保存类按钮不要用本工具，改用 ui_click 处理其确认/高亮闸门。",
  parameters: z.object({
    id: z.string().describe("要填写的输入项 id（来自系统提供的可用动作清单中 kind=input/select/textarea 的项）"),
    value: z.string().describe("要写入的值（字符串形式，数字/枚举也按字符串传）"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const id = String(args && args.id || "");
    const value = String((args && args.value) ?? "");
    if (!id) {
      return { ok: false, ui: { type: "fill", id: "", valid: false }, hint: "Missing field id." };
    }
    const actions = (context as any).uiActions as UIActionRegistryEntry[] | undefined;
    const entry = actions?.find((a) => a.id === id);
    if (!entry) {
      return {
        ok: false,
        ui: { type: "fill", id, valid: false },
        hint:
          "Field '" + id + "' not in the current system's registered actions. Available: " +
          (actions?.map((a) => a.id).join(", ") || "(none)"),
      };
    }
    const kindParse = KIND.safeParse(entry.kind);
    if (!kindParse.success) {
      return {
        ok: false,
        ui: { type: "fill", id, valid: false },
        hint: `Action "${entry.label}" is a ${entry.kind ?? "button"}, not a fillable input. Use ui_click instead to trigger it.`,
      };
    }
    if (entry.risk !== "none") {
      return {
        ok: false,
        ui: { type: "fill", id, valid: false },
        hint: `Field "${entry.label}" has risk=${entry.risk} and must not be filled via ui_fill; route side-effecting actions through ui_click confirm/highlight gates.`,
      };
    }
    // 通用顺序前置校验（基于协议字段 after，与业务无关）：如填表项要求先进入对应页面。
    const done = new Set<string>((context as any).executedUiActions ?? []);
    if (entry.after && entry.after.length > 0) {
      const missing = entry.after.filter((id) => !done.has(id));
      if (missing.length > 0) {
        return {
          ok: false,
          ui: { type: "fill", id, valid: false },
          hint:
            `Field "${entry.label}" 有前置依赖，需先依次完成：【${missing.join("、")}】` +
            `。请先用 ui_click 触发这些前置动作（如进入对应页面）再填写本字段，不要跳步。`,
        };
      }
    }
    return {
      ok: true,
      ui: { type: "fill", id: entry.id, label: entry.label, page: entry.page, value },
      hint: `Fill "${entry.label}" with "${value}"`,
    };
  },
};

// 便捷导出（需 opt-in）
export const uiFillTools: ToolDefinition[] = [uiFillTool];
