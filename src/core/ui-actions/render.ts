import type { UIActionRegistryEntry } from "./types.js";

// 平台级动作清单渲染器（通用，不绑定业务）。
//
// 输入前端上报的 context.uiActions，输出给模型看的"带顺序与前置关系的动作清单"。
// 只依据通用协议字段（desc / step / after / options / entry）渲染：
//   - 有 step 时按 step 分组，把同一阶段的动作放一起，暗示执行顺序；
//   - 有 after 时标明"需先做：xxx"，作为显式顺序约束；
//   - 有 options 时列出合法取值，帮助模型正确填 select；
//   - entry 动作单独标出，提醒这是进入下一步的入口。
// 任何页面只要把字段补全即可获得同样的"顺序引导"，无需为中台做业务特化。

function kindText(a: UIActionRegistryEntry): string {
  if (a.kind && a.kind !== "button") return `类型=${a.kind}（用 ui_fill 填写）`;
  return "类型=按钮（用 ui_click 触发）";
}

function riskText(risk: UIActionRegistryEntry["risk"]): string {
  if (risk === "critical") return "关键操作(critical，前端高亮诱导用户点击，不自动触发)";
  if (risk === "mutating") return "有副作用(mutating，行动模式需用户通过)";
  return "只读(none)";
}

function lineFor(a: UIActionRegistryEntry): string {
  const prefix = a.entry ? "入口：" : "";
  const desc = a.desc ? `，${a.desc}` : "";
  const after =
    a.after && a.after.length > 0 ? `；【需先做：${a.after.join("、")}】` : "";
  const options =
    a.options && a.options.length > 0
      ? `；可选值：${a.options.map((o) => o.value).join("/")}`
      : "";
  return `- id=${a.id}，名称「${a.label || a.id}」，页面 ${a.page || "?"}，${kindText(a)}，风险=${riskText(a.risk)}${desc}${after}${options}`;
}

export function renderUiActions(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) {
    return "（当前没有可触发的页面动作）";
  }
  const list = actions as UIActionRegistryEntry[];
  const withStep = list.filter((a) => a.step);
  const noStep = list.filter((a) => !a.step);

  const groups = new Map<string, UIActionRegistryEntry[]>();
  for (const a of withStep) {
    const key = a.step || "其他";
    const arr = groups.get(key) ?? [];
    arr.push(a);
    groups.set(key, arr);
  }

  const out: string[] = [];
  for (const [step, items] of groups.entries()) {
    out.push(`【${step}】`);
    for (const a of items) out.push(lineFor(a));
  }
  if (noStep.length > 0) {
    out.push("【其他】");
    for (const a of noStep) out.push(lineFor(a));
  }
  return out.join("\n");
}
