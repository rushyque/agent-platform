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

// 班报：聚合最近 N 个班次的收支与产出，供 factory_shift_report 工具调用。
// 诚实边界（核实 engine.ts）：cash 是单累加器、固定开支未写进 log、无按订单成本账。
// 因此 income 用结构化字段(order.deliveredAtShift + order.price)可靠取得；
// expenseEstimate 只能从 log 文本正则归类，标 estimate:true；不算利润率/单订单成本。
export function shiftReportSummary(state: GameState, lastShifts: number) {
  const to = state.shift;
  const from = Math.max(1, to - lastShifts + 1);
  const inWin = (s: number) => s >= from && s <= to;

  // 收入：窗口内交付的订单（结构化，可靠）
  const delivered = state.orders.filter((o) => o.deliveredAtShift != null && inWin(o.deliveredAtShift));
  const income = delivered.reduce((sum, o) => sum + o.price, 0);

  // 支出：从 log 文本正则归类（成本类金额只存 log，无法结构化 → 标 estimate）
  // 关键：只认"实际发生"的关键字（花费/扣罚金/投入），排除【事件】描述里的"可选花费"
  // （如 material_delay 的"加急 ¥8000 或等待"是选项，未真实扣款，不计入）。
  const lines = state.log.filter((l) => inWin(l.shift) && !l.text.startsWith("【事件】"));
  const expense: Record<string, number> = { purchase: 0, repair: 0, expedite: 0, penalty: 0, research: 0 };
  const addAmounts = (text: string, key: keyof typeof expense) => {
    for (const m of text.matchAll(/¥\s*(-?\d+)/g)) expense[key] += Number(m[1]);
  };
  for (const l of lines) {
    if (l.text.includes("采购") && l.text.includes("花费")) addAmounts(l.text, "purchase");
    else if (l.text.includes("维修") && l.text.includes("花费")) addAmounts(l.text, "repair");
    else if (l.text.includes("加急") && l.text.includes("花费")) addAmounts(l.text, "expedite");
    else if (l.text.includes("扣罚金")) addAmounts(l.text, "penalty");
    else if (l.text.includes("研发") && l.text.includes("投入")) addAmounts(l.text, "research");
  }
  const expenseTotal = Object.values(expense).reduce((a, b) => a + b, 0);

  const completedSteps = lines.filter((l) => l.kind === "good" && l.text.includes("完成")).length;
  const eventsSpawned = lines.filter((l) => l.text.includes("【事件】")).length;

  // log 截断 60 条(engine.ts:38)：若窗口左端早于最旧 log，说明更早班次的流水已被挤掉，不全
  const oldestShift = state.log.length ? state.log[state.log.length - 1].shift : to;
  const logAvailable = oldestShift <= from;

  return {
    window: { fromShift: from, toShift: to },
    income,
    deliveries: delivered.length,
    expenseEstimate: { ...expense, total: expenseTotal, estimate: true },
    completedSteps,
    eventsSpawned,
    snapshot: {
      cash: state.cash,
      reputation: state.reputation,
      shift: state.shift,
      inventory: state.inventory.map((i) => ({ grade: i.grade, qty: i.qty })),
      inProduction: state.orders.filter((o) => o.status === "in_production").length,
      gameOver: state.gameOver,
    },
    logAvailable,
    note: logAvailable
      ? "固定工资/能耗开支按班次扣现金但未逐笔记入日志，故未计入支出估算；本表只含可追溯的采购/维修/加急/逾期/研发支出。"
      : "部分班次的日志已被滚动挤出（仅保留近 60 条），较早班次数据可能缺失。",
  };
}
