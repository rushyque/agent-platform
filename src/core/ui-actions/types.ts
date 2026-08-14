// 平台级"前端动作清单"契约类型。
//
// 由前端经请求头 x-ui-actions 上报，中台 core 只认这套通用协议字段，不绑定任何
// 具体业务平台。任何接入系统只要按协议补全字段即可复用 ui_click / ui_fill 与渲染器。

export type UIActionRisk = "none" | "mutating" | "critical";
export type UIActionKind = "button" | "input" | "select" | "textarea";

export interface UIActionRegistryEntry {
  id: string;
  label: string;
  page: string;
  risk: UIActionRisk;
  kind?: UIActionKind; // 缺省视为 button

  // --- 通用描述协议字段（可空，缺省则由渲染器用 id/label 兜底） ---
  desc?: string; // 一句话语义描述：这个动作做什么、什么时候用
  step?: string; // 归属阶段标签（如"入口/填写/提交"），渲染时按它分组给模型看顺序
  after?: string[]; // 执行前必须先做的前置动作 id（通用顺序约束）
  options?: Array<{ value: string; label?: string }>; // select/枚举输入可用的合法取值
  entry?: boolean; // 是否进入下一个子页面的入口动作
  to?: string; // 入口动作(entry)的目标子页面路由；执行后会跳到该页，供中台正确跟踪当前页
}
