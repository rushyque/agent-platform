import type { UIActionRegistryEntry } from "./types.js";

// 平台级"通用前置已满足"判定 —— 与业务无关，只依赖动作清单协议字段。
//
// 核心语义：一个 `entry` 入口动作声明了 `to`（执行后跳到的目标子页）。当模型
// 当前已经身处该入口的 `to` 页（或已进入其更深的同模块子页）时，说明"进入目标页"
// 这个前置在到达当前页时就已天然满足——即使本轮并没有通过点击该入口按钮把它登记进
// executedUiActions。此时应把该入口算作"已满足"，否则 ui_fill / ui_click 的 after
// 校验会用"未点击入口"的名义拒绝填表，而 get_page_state 又显示字段未阻塞，形成
// 自相矛盾，模型会被误导成"回到列表页重触发入口"而无限绕圈。
//
// 这套逻辑在 ui_fill / ui_click / get_page_state 三处共用，保证三者对"入口是否已满足"
// 的口径完全一致，根治上述绕圈，且任何接入系统只要按 entry/to/page 协议补全即可复用。

/** normalize 页面：去掉 query、把动态路由（如 /inquiries/:id）归一。 */
export function normalizePage(page: string): string {
  const p = String(page || "").split("?")[0];
  if (/^\/inquiries\/new\/?$/.test(p)) return "/inquiries/new";
  if (/^\/inquiries\/[^/]+/.test(p)) return "/inquiries/:id";
  return p;
}

/** 当前页是否已"更深"地进入 entryPage 标识的模块子页（无 to 时的保守兜底）。 */
function isDeeperSubpage(entryPage: string, currentPage: string): boolean {
  const ep = normalizePage(entryPage);
  const cp = normalizePage(currentPage);
  if (!ep || ep === "/" || cp === ep) return false;
  if (cp.startsWith(ep + "/")) return true;
  return false;
}

/** 判断一个 entry 入口动作在当前页是否已天然满足（无需点击登记）。 */
export function isEntrySatisfied(
  entry: UIActionRegistryEntry,
  currentPage: string | undefined
): boolean {
  if (!entry.entry) return false;
  const cp = normalizePage(currentPage || "");
  if (!cp) return false;
  if (entry.to) return normalizePage(entry.to) === cp;
  // 无 to 时用"更深的同模块子页"启发式兜底。
  return isDeeperSubpage(entry.page, cp);
}

/**
 * 计算"生效的前置已完成"集合：在原始已执行动作之上，并入所有在当前页已天然满足的
 * 入口动作。ui_fill / ui_click 的 after 校验与 get_page_state 的展示都应基于此集合，
 * 保证"入口是否已满足"的口径一致，避免模型被内部矛盾误导而绕圈。
 */
export function computeEffectiveDone(
  actions: UIActionRegistryEntry[] | undefined,
  rawDone: Iterable<string>,
  currentPage: string | undefined
): Set<string> {
  const eff = new Set<string>(rawDone);
  if (Array.isArray(actions)) {
    for (const a of actions) {
      if (isEntrySatisfied(a, currentPage)) eff.add(a.id);
    }
  }
  return eff;
}
