// observe_state 摘要 —— 工厂项目的"看全局现状"钩子。
// 供中台 coreTools.observeState 调用：agent-config 在 resolveContext 注入
//   getState: (ctx, focus?) => factoryStateSummary(ctx.userId, focus)
// 比工厂 view_dashboard（仅计数）更进一步：列出具体订单、即将逾期、库存、近期日志。
import { getGameState } from "./game/state-store.js";
import { summarizeOrder, dashboardSummary } from "./tools/views.js";
import { TECH_NODE } from "./game/tech.js";

export function factoryStateSummary(userId: string, focus?: string): any {
  const state = getGameState(userId);

  // 即将逾期：未交付且交期剩余 ≤2 班（dashboard 里没有，厂长最关心的提前量）
  const dueSoon = state.orders
    .filter((o) => o.status !== "delivered" && o.status !== "inquiry" && o.dueShift - state.shift <= 2)
    .map((o) => ({
      id: o.id,
      customer: o.customer,
      dueShift: o.dueShift,
      remaining: o.dueShift - state.shift,
      status: o.status,
    }))
    .sort((a, b) => a.remaining - b.remaining);

  if (focus === "orders") {
    return {
      shift: state.shift,
      orders: state.orders.map(summarizeOrder),
      dueSoon,
    };
  }

  if (focus === "workshop") {
    const machineStatus = { idle: 0, running: 0, broken: 0, maintenance: 0 } as Record<string, number>;
    for (const m of state.machines) machineStatus[m.status] = (machineStatus[m.status] ?? 0) + 1;
    return {
      shift: state.shift,
      machineStatus,
      machines: state.machines.map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        status: m.status,
        orderId: m.orderId,
        remaining: m.remaining,
        total: m.total,
      })),
    };
  }

  if (focus === "inventory") {
    return { shift: state.shift, cash: state.cash, reputation: state.reputation, inventory: state.inventory };
  }

  // 缺省：完整概览（dashboard 基础上补具体订单/即将逾期/库存/近期日志）
  const researching = state.tech.researching;
  return {
    ...dashboardSummary(state),
    dueSoon,
    orders: state.orders.map(summarizeOrder),
    inventory: state.inventory.map((i) => ({ grade: i.grade, qty: i.qty })),
    researching: researching
      ? {
          name: TECH_NODE[researching.nodeId]?.name ?? researching.nodeId,
          progress: `${researching.total - researching.remaining}/${researching.total}`,
        }
      : null,
    recentLog: state.log.slice(0, 8).map((l) => ({ shift: l.shift, text: l.text, kind: l.kind })),
  };
}
