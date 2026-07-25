// 工具层共用：把订单/工序渲染成精简、模型友好的摘要。
import type { Order, GameState } from "../game/types.js";
import { MOLD_LABEL, PROCESS_LABEL, ORDER_STATUS_LABEL } from "../game/types.js";
import { TECH_NODE } from "../game/tech.js";

export interface OrderSummary {
  id: string;
  customer: string;
  mold: string;
  qty: number;
  price: number;
  dueShift: number;
  status: string;
  rush: boolean;
  progress: string; // "2/5"
  steelGrade?: string;
  steelNeeded?: number;
  steelConsumed?: boolean;
  trialPassed?: boolean;
  nextStep?: string; // 下一个待加工工序
}

export function summarizeOrder(order: Order): OrderSummary {
  const done = order.steps.filter((s) => s.status === "done").length;
  const total = order.steps.length;
  const next = order.steps.find((s) => s.status === "pending");
  return {
    id: order.id,
    customer: order.customer,
    mold: MOLD_LABEL[order.moldType],
    qty: order.qty,
    price: order.price,
    dueShift: order.dueShift,
    status: ORDER_STATUS_LABEL[order.status],
    rush: order.rush,
    progress: total ? `${done}/${total}` : "—",
    steelGrade: order.steelGrade,
    steelNeeded: order.steelNeeded,
    steelConsumed: order.steelConsumed,
    trialPassed: order.trialPassed,
    nextStep: next ? PROCESS_LABEL[next.process] : undefined,
  };
}

export function dashboardSummary(state: GameState) {
  const byStatus: Record<string, number> = {};
  for (const o of state.orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  const machineStatus = { idle: 0, running: 0, broken: 0, maintenance: 0 } as Record<string, number>;
  for (const m of state.machines) machineStatus[m.status] = (machineStatus[m.status] ?? 0) + 1;
  const activeEvents = state.events.filter((e) => !e.resolved).length;
  const researching = state.tech.researching;
  return {
    factoryName: state.factoryName,
    shift: state.shift,
    cash: state.cash,
    reputation: state.reputation,
    gameOver: state.gameOver,
    machines: machineStatus,
    ordersByStatus: byStatus,
    activeEvents,
    inquiryCount: byStatus["inquiry"] ?? 0,
    researchedTech: state.tech.researched.length,
    researching: researching
      ? {
          name: TECH_NODE[researching.nodeId]?.name ?? researching.nodeId,
          progress: `${researching.total - researching.remaining}/${researching.total}`,
        }
      : null,
  };
}
