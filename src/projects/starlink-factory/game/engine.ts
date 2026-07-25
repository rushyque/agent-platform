// 星联模具工厂 —— 游戏引擎（核心状态机）。
// 所有工具最终落到这里的纯函数（对 GameState 取改），完成后推送一条总线事件。
import type {
  GameState,
  Order,
  Machine,
  ProcessType,
  ProcessStep,
  MachineType,
  GameEvent,
} from "./types.js";
import {
  PROCESS_MACHINE,
  BASE_STEP_TIME,
  PROCESS_LABEL,
  MACHINE_TYPE_LABEL,
  MOLD_LABEL,
  STEEL_PRICE,
  ORDER_STATUS_LABEL,
} from "./types.js";
import { MOLD_SPECS, STEEL_PER_QTY, generateInquiry } from "./world.js";
import { emitGameEvent } from "./game-bus.js";
import { getTechEffects, TECH_NODE } from "./tech.js";

const SHIFT_OVERHEAD = 8000; // 每班次工资/能耗固定开支（lean 科技可降到 6000）
const REPAIR_COST = 15000;

export interface OpResult {
  ok: boolean;
  message: string;
  data?: Record<string, any>;
}

// ---- 内部辅助 ----

function log(state: GameState, text: string, kind: GameState["log"][number]["kind"] = "info"): void {
  state.log.unshift({ shift: state.shift, text, kind });
  if (state.log.length > 60) state.log.pop();
}

function findOrder(state: GameState, orderId: string): Order | undefined {
  return state.orders.find((o) => o.id === orderId);
}

function findMachine(state: GameState, machineId: string): Machine | undefined {
  return state.machines.find((m) => m.id === machineId);
}

// 推进连续的"手工工位"工序（抛光/装配）：到达即完成，不占机床
function collapseBenchSteps(order: Order, eff: ReturnType<typeof getTechEffects>): void {
  for (const step of order.steps) {
    if (step.status === "pending" && PROCESS_MACHINE[step.process] === null) {
      step.status = "done";
      let q = 88 + Math.floor(Math.random() * 10);
      if (step.process === "polish") q += eff.polishQualityBonus;
      q += eff.qualityBonus;
      step.quality = q;
    } else if (step.status === "pending") {
      break; // 遇到需机床的工序，停下等排产
    }
  }
}

// 下一个待排产（需机床）的工序
function nextSchedulableStep(order: Order): ProcessStep | undefined {
  return order.steps.find((s) => s.status === "pending" && PROCESS_MACHINE[s.process] !== null);
}

function allStepsDone(order: Order): boolean {
  return order.steps.length > 0 && order.steps.every((s) => s.status === "done");
}

function clampRep(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// 推送总线事件（克隆快照，保证前端拿到点状数据）
function emit(state: GameState, kind: string, summary: string): void {
  emitGameEvent(state.userId, {
    kind,
    summary,
    snapshot: JSON.parse(JSON.stringify(state)) as GameState,
  });
}

// ---- 工具操作 ----

export function acceptInquiry(state: GameState, orderId: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const order = findOrder(state, orderId);
  if (!order) return fail(`未找到订单 ${orderId}。`);
  if (order.status !== "inquiry") return fail(`${orderId} 当前为「${ORDER_STATUS_LABEL[order.status]}」，不能接单。`);
  order.status = "accepted";
  order.acceptedAtShift = state.shift;
  log(state, `接下 ${order.customer} 的订单 ${orderId}（${MOLD_LABEL[order.moldType]} ×${order.qty}，报价 ¥${order.price}）。`, "good");
  emit(state, "accept_inquiry", `接单 ${orderId}：${order.customer}`);
  return ok(`已接单 ${orderId}。下一步：开始设计（start_design）。`);
}

export function startDesign(state: GameState, orderId: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const order = findOrder(state, orderId);
  if (!order) return fail(`未找到订单 ${orderId}。`);
  if (order.status !== "accepted") return fail(`${orderId} 必须「已接单」才能设计，当前为「${ORDER_STATUS_LABEL[order.status]}」。`);
  const spec = MOLD_SPECS[order.moldType];
  order.steps = spec.routing.map((p) => ({ process: p, status: "pending" }));
  order.steelGrade = spec.steelGrade;
  order.steelNeeded = STEEL_PER_QTY[order.moldType] * order.qty;
  order.steelConsumed = false;
  order.designQuality = 65 + Math.floor(Math.random() * 30); // 65~94
  collapseBenchSteps(order, getTechEffects(state));
  order.status = allStepsDone(order) ? "trial_pending" : "ready";
  const route = spec.routing.map((p) => PROCESS_LABEL[p]).join(" → ");
  log(state, `${orderId} 设计完成。工艺路线：${route}；需钢料 ${order.steelGrade}×${order.steelNeeded} 块；设计水平 ${order.designQuality}。`, "info");
  emit(state, "start_design", `${orderId} 设计完成`);
  return ok(`${orderId} 设计完成，工艺 ${order.steps.length} 步，需 ${order.steelGrade}×${order.steelNeeded}。下一步：把待加工工序排到机床（schedule_job）。`, { routing: route });
}

export function scheduleJob(state: GameState, orderId: string, machineId?: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const order = findOrder(state, orderId);
  if (!order) return fail(`未找到订单 ${orderId}。`);
  if (order.status !== "ready" && order.status !== "in_production") {
    return fail(`${orderId} 当前「${ORDER_STATUS_LABEL[order.status]}」，无法排产（需为「待排产」或「加工中」）。`);
  }
  const step = nextSchedulableStep(order);
  if (!step) {
    if (allStepsDone(order)) {
      order.status = "trial_pending";
      emit(state, "schedule_job", `${orderId} 全部工序完成`);
      return ok(`${orderId} 已无待加工工序，可试模（run_trial）。`);
    }
    return fail(`${orderId} 没有可排产的工序。`);
  }
  const needType = PROCESS_MACHINE[step.process] as MachineType;
  // 选机床
  let machine: Machine | undefined;
  if (machineId) {
    machine = findMachine(state, machineId);
    if (!machine) return fail(`未找到机床 ${machineId}。`);
    if (machine.type !== needType) return fail(`${machine.name} 是${MACHINE_TYPE_LABEL[machine.type]}，而「${PROCESS_LABEL[step.process]}」需要${MACHINE_TYPE_LABEL[needType]}。`);
    if (machine.status !== "idle") return fail(`${machine.name} 当前「${machine.status}」，不能上料。`);
  } else {
    machine = state.machines.find((m) => m.type === needType && m.status === "idle");
    if (!machine) return fail(`没有空闲的${MACHINE_TYPE_LABEL[needType]}，请等待或指定其它机床。`);
  }
  // 首个加工工序上料时扣钢料
  if (!order.steelConsumed) {
    const inv = state.inventory.find((i) => i.grade === order.steelGrade);
    const have = inv?.qty ?? 0;
    if (have < (order.steelNeeded ?? 0)) {
      return fail(`钢料不足：需 ${order.steelGrade}×${order.steelNeeded}，库存仅 ${have}。请先采购（purchase_material）。`);
    }
    inv!.qty -= order.steelNeeded!;
    order.steelConsumed = true;
    log(state, `${orderId} 投料 ${order.steelGrade}×${order.steelNeeded}。`, "info");
  }
  // 计算工时并占用机床（科技：机床速度升级 / 多腔+自动化 / SMED 减工时）
  const eff = getTechEffects(state);
  let effSpeed = machine.speed + eff.globalSpeedBonus;
  if (machine.type === "cnc_mill") effSpeed += eff.cncSpeedBonus;
  else if (machine.type === "edm") effSpeed += eff.edmSpeedBonus;
  const rawTime = Math.ceil((BASE_STEP_TIME[step.process] * order.qty) / effSpeed);
  const time = Math.max(1, rawTime - eff.scheduleTimeBonus);
  step.status = "running";
  step.machineId = machine.id;
  step.remaining = time;
  step.total = time;
  machine.status = "running";
  machine.orderId = order.id;
  machine.remaining = time;
  machine.total = time;
  order.status = "in_production";
  log(state, `${orderId}「${PROCESS_LABEL[step.process]}」上 ${machine.name}，预计 ${time} 班次。`, "info");
  emit(state, "schedule_job", `${orderId} ${PROCESS_LABEL[step.process]} → ${machine.name}`);
  return ok(`${orderId}「${PROCESS_LABEL[step.process]}」已排上 ${machine.name}（${time} 班次）。`);
}

export function unscheduleJob(state: GameState, orderId: string): OpResult {
  const order = findOrder(state, orderId);
  if (!order) return fail(`未找到订单 ${orderId}。`);
  const step = order.steps.find((s) => s.status === "running");
  if (!step) return fail(`${orderId} 当前没有在机工序可取消。`);
  const machine = step.machineId ? findMachine(state, step.machineId) : undefined;
  step.status = "pending";
  step.machineId = undefined;
  step.remaining = undefined;
  step.total = undefined;
  if (machine) {
    machine.status = "idle";
    machine.orderId = undefined;
    machine.remaining = undefined;
    machine.total = undefined;
  }
  log(state, `${orderId}「${PROCESS_LABEL[step.process]}」已撤下，机床 ${machine?.name ?? "—"} 释放。`, "warn");
  emit(state, "unschedule", `${orderId} 撤下 ${PROCESS_LABEL[step.process]}`);
  return ok(`${orderId} 在机工序已取消，机床已释放。`);
}

export function purchaseMaterial(state: GameState, grade: string, qty: number): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const price = STEEL_PRICE[grade];
  if (!price) return fail(`未知钢料牌号 ${grade}（可选：P20 / 718H / S136）。`);
  if (qty <= 0) return fail("采购数量必须大于 0。");
  const cost = Math.round(price * qty * (1 - getTechEffects(state).materialDiscount));
  if (state.cash < cost) return fail(`现金不足：采购 ${grade}×${qty} 需 ¥${cost}，仅余 ¥${state.cash}。`);
  state.cash -= cost;
  let inv = state.inventory.find((i) => i.grade === grade);
  if (!inv) {
    inv = { grade, qty: 0 };
    state.inventory.push(inv);
  }
  inv.qty += qty;
  log(state, `采购钢料 ${grade}×${qty}，花费 ¥${cost}。`, "info");
  emit(state, "purchase_material", `采购 ${grade}×${qty}（-¥${cost}）`);
  return ok(`已采购 ${grade}×${qty}，花费 ¥${cost}，库存现 ${inv.qty}。`);
}

export function runTrial(state: GameState, orderId: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const order = findOrder(state, orderId);
  if (!order) return fail(`未找到订单 ${orderId}。`);
  if (order.status !== "trial_pending") return fail(`${orderId} 必须「待试模」才能试模（当前「${ORDER_STATUS_LABEL[order.status]}」）。`);
  const injector = state.machines.find((m) => m.type === "trial_injector");
  if (injector && injector.status !== "idle") return fail(`试模注塑机当前「${injector.status}」，暂不可用。`);
  // 质量分：工序质量均值 ×0.6 + 设计水平 ×0.4 + 噪声（科技：spc 降门槛 / trial_sim 降噪）
  const eff = getTechEffects(state);
  const doneQualities = order.steps.map((s) => s.quality ?? 80);
  const avgStep = doneQualities.reduce((a, b) => a + b, 0) / Math.max(1, doneQualities.length);
  const noise = Math.random() * 2 * eff.trialNoise - eff.trialNoise;
  const score = avgStep * 0.6 + (order.designQuality ?? 75) * 0.4 + noise;
  const pass = score >= eff.trialThreshold;
  if (pass) {
    order.trialPassed = true;
    log(state, `${orderId} 试模合格（质量分 ${score.toFixed(1)}）。可交付。`, "good");
    emit(state, "run_trial", `${orderId} 试模合格 ✓`);
    return ok(`${orderId} 试模合格（质量分 ${score.toFixed(1)}），可交付（deliver_order）。`);
  }
  // 返工：找质量最低的加工工序重做
  let worst: ProcessStep | undefined;
  for (const s of order.steps) {
    if (PROCESS_MACHINE[s.process] !== null && s.status === "done") {
      if (!worst || (s.quality ?? 100) < (worst.quality ?? 100)) worst = s;
    }
  }
  if (worst) {
    worst.status = "pending";
    worst.quality = undefined;
    order.status = "ready";
    log(state, `${orderId} 试模不合格（${score.toFixed(1)}），返工「${PROCESS_LABEL[worst.process]}」。`, "warn");
    emit(state, "run_trial", `${orderId} 试模不合格 ✗ 返工`);
    return ok(`${orderId} 试模不合格（${score.toFixed(1)}），需返工「${PROCESS_LABEL[worst.process]}」，请重新排产。`);
  }
  order.status = "ready";
  emit(state, "run_trial", `${orderId} 试模不合格`);
  return ok(`${orderId} 试模不合格，请重新排产加工。`);
}

export function deliverOrder(state: GameState, orderId: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const order = findOrder(state, orderId);
  if (!order) return fail(`未找到订单 ${orderId}。`);
  if (order.status !== "trial_pending" || !order.trialPassed) {
    return fail(`${orderId} 必须「试模合格」才能交付（当前「${ORDER_STATUS_LABEL[order.status]}」）。`);
  }
  order.status = "delivered";
  order.deliveredAtShift = state.shift;
  state.cash += order.price;
  const onTime = state.shift <= order.dueShift;
  state.reputation = clampRep(state.reputation + (onTime ? 4 : -3));
  log(state, `交付 ${orderId} 给 ${order.customer}，回款 ¥${order.price}${onTime ? "（按时交付，声誉+4）" : "（逾期交付，声誉-3）"}。`, onTime ? "good" : "warn");
  emit(state, "deliver_order", `交付 ${orderId}（+¥${order.price}）`);
  return ok(`${orderId} 已交付，回款 ¥${order.price}，声誉 ${state.reputation}。`);
}

export function handleEvent(state: GameState, eventId: string, choice: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const ev = state.events.find((e) => e.id === eventId);
  if (!ev) return fail(`未找到事件 ${eventId}。`);
  if (ev.resolved) return fail(`${eventId} 已处理。`);
  switch (ev.type) {
    case "machine_breakdown": {
      const machine = ev.payload?.machineId ? findMachine(state, ev.payload.machineId) : undefined;
      if (choice === "repair") {
        if (state.cash < REPAIR_COST) return fail(`现金不足，维修需 ¥${REPAIR_COST}。`);
        state.cash -= REPAIR_COST;
        if (machine) {
          machine.status = "idle";
          machine.orderId = undefined;
          machine.remaining = undefined;
          machine.total = undefined;
          // 该机床上的在制工序退回待排产
          for (const o of state.orders) {
            const s = o.steps.find((st) => st.machineId === machine.id && st.status === "running");
            if (s) { s.status = "pending"; s.machineId = undefined; s.remaining = undefined; s.total = undefined; }
          }
        }
        ev.resolved = true;
        log(state, `维修 ${machine?.name ?? "设备"} 完成，花费 ¥${REPAIR_COST}。`, "info");
      } else {
        if (machine) machine.status = "broken";
        ev.resolved = true;
        log(state, `暂缓维修 ${machine?.name ?? "设备"}，该设备保持故障。`, "warn");
      }
      break;
    }
    case "rush_order": {
      if (choice === "accept") {
        const o = generateInquiry(state as unknown as { seq: number }, state.shift, { rush: true });
        state.orders.push(o);
        log(state, `接下紧急单 ${o.id}：${o.customer}（${MOLD_LABEL[o.moldType]} ×${o.qty}，溢价报价 ¥${o.price}）。`, "good");
      } else {
        state.reputation = clampRep(state.reputation - 1);
        log(state, `拒绝紧急插单，声誉 -1。`, "warn");
      }
      ev.resolved = true;
      break;
    }
    case "material_delay": {
      if (choice === "expedite") {
        if (state.cash < 8000) return fail("现金不足，加急需 ¥8000。");
        state.cash -= 8000;
        log(state, `加急钢料到货，花费 ¥8000。`, "info");
      } else {
        const grade = ev.payload?.grade ?? "S136";
        const inv = state.inventory.find((i) => i.grade === grade);
        if (inv) inv.qty = Math.max(0, inv.qty - 10);
        log(state, `等待钢料 ${grade}，到货延迟，库存 -10。`, "warn");
      }
      ev.resolved = true;
      break;
    }
    case "customer_urge": {
      const order = ev.payload?.orderId ? findOrder(state, ev.payload.orderId) : undefined;
      if (choice === "apologize") {
        state.reputation = clampRep(state.reputation - 2);
        log(state, `${order?.customer ?? "客户"}催货，安抚致歉，声誉 -2。`, "warn");
      } else {
        state.reputation = clampRep(state.reputation - 4);
        log(state, `无视 ${order?.customer ?? "客户"}催货，声誉 -4。`, "bad");
      }
      ev.resolved = true;
      break;
    }
  }
  emit(state, "handle_event", `事件 ${eventId} 已处理`);
  return ok(`事件 ${eventId} 已按「${choice}」处理。`);
}

interface ShiftResult {
  completed: string[];
  newInquiry?: string;
  eventSpawned: boolean;
  techCompleted?: string;
  bankrupt: boolean;
}

// 单班次推进的纯变更 + 日志，不 emit（供单班/批量复用）
function advanceShiftOnce(state: GameState): ShiftResult {
  const eff = getTechEffects(state);
  state.shift += 1;
  const completed: string[] = [];
  const res: ShiftResult = { completed, eventSpawned: false, bankrupt: false };
  // 1. 推进所有运行中机床
  for (const machine of state.machines) {
    if (machine.status === "running" && machine.remaining != null) {
      machine.remaining -= 1;
      const order = machine.orderId ? findOrder(state, machine.orderId) : undefined;
      if (order) {
        const step = order.steps.find((s) => s.machineId === machine.id && s.status === "running");
        if (step && step.remaining != null) step.remaining = machine.remaining;
      }
      if (machine.remaining <= 0) {
        // 工序完成（科技：wire_preproc 提升 CNC 质量 / qms 全局质量）
        if (order) {
          const step = order.steps.find((s) => s.machineId === machine.id && s.status === "running");
          if (step) {
            step.status = "done";
            let q = 78 + machine.speed * 10 + (Math.random() * 14 - 7);
            if (step.process === "rough_cnc" || step.process === "finish_cnc") q += eff.cncQualityBonus;
            q += eff.qualityBonus;
            step.quality = Math.round(clampRep(q));
            step.remaining = undefined;
            completed.push(`${order.id}「${PROCESS_LABEL[step.process]}」完成`);
            collapseBenchSteps(order, eff);
            if (allStepsDone(order)) {
              order.status = "trial_pending";
              completed.push(`${order.id} 全部工序完成，可试模`);
            }
          }
        }
        machine.status = "idle";
        machine.orderId = undefined;
        machine.remaining = undefined;
        machine.total = undefined;
      }
    }
  }
  // 2. 逾期罚金（只计一次）
  for (const o of state.orders) {
    if (!o.lateCharged && o.status !== "inquiry" && o.status !== "delivered" && o.status !== "overdue" && state.shift > o.dueShift) {
      o.lateCharged = true;
      state.cash -= o.penalty;
      state.reputation = clampRep(state.reputation - 6);
      log(state, `${o.id}（${o.customer}）逾期，扣罚金 ¥${o.penalty}，声誉 -6。`, "bad");
    }
  }
  // 3. 固定开支（科技：lean 降开支）
  state.cash -= eff.overhead;
  // 4. 随机事件（科技：predictive_maint / supply_chain 屏蔽对应类型）
  if (Math.random() < 0.28) {
    res.eventSpawned = spawnRandomEvent(state, eff);
  }
  // 5. 偶发新询价
  if (Math.random() < 0.3) {
    const inq = generateInquiry(state as unknown as { seq: number }, state.shift);
    state.orders.push(inq);
    log(state, `新询价 ${inq.id}：${inq.customer}（${MOLD_LABEL[inq.moldType]} ×${inq.qty}，¥${inq.price}）。`, "info");
    res.newInquiry = inq.id;
  }
  // 6. 科技研发 tick
  if (state.tech.researching) {
    state.tech.researching.remaining -= 1;
    if (state.tech.researching.remaining <= 0) {
      const done = state.tech.researching.nodeId;
      state.tech.researched.push(done);
      const node = TECH_NODE[done];
      state.tech.researching = undefined;
      log(state, `【科技】${node?.name ?? done} 研发完成，效果生效。`, "good");
      res.techCompleted = node?.name ?? done;
    }
  }
  // 7. 破产判定
  if (state.cash < 0) {
    state.gameOver = true;
    log(state, `现金耗尽（¥${state.cash}），工厂破产。`, "bad");
    res.bankrupt = true;
  }
  for (const c of completed) log(state, c, "good");
  return res;
}

export function advanceShift(state: GameState): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const r = advanceShiftOnce(state);
  const summary = `第 ${state.shift} 班次：${r.completed.length ? r.completed.join("；") : "平稳推进"}`;
  emit(state, "advance_shift", summary);
  return ok(
    `第 ${state.shift} 班次结束。${r.completed.length ? "完成：" + r.completed.join("；") + "。" : ""}现金 ¥${state.cash}，声誉 ${state.reputation}${r.bankrupt ? "，工厂已破产" : ""}。`
  );
}

// 批量推进：把 N 个班次压缩成一次工具调用（根治多班次流程被步数上限截断）
export function advanceShifts(state: GameState, count: number): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const n = Math.max(1, Math.min(12, Math.floor(count)));
  const fromShift = state.shift + 1;
  const allCompleted: string[] = [];
  const techDone: string[] = [];
  let eventCount = 0;
  let ran = 0;
  for (let i = 0; i < n; i++) {
    if (state.gameOver) break;
    const r = advanceShiftOnce(state);
    ran++;
    allCompleted.push(...r.completed);
    if (r.eventSpawned) eventCount++;
    if (r.techCompleted) techDone.push(r.techCompleted);
  }
  const parts = [`连续推进 ${ran} 个班次（第 ${fromShift}–${state.shift} 班）`];
  if (allCompleted.length) parts.push(`共完成 ${allCompleted.length} 项工序`);
  if (techDone.length) parts.push(`科技研发完成：` + techDone.join("、"));
  if (eventCount) parts.push(`期间触发 ${eventCount} 个待处理事件`);
  const summary = parts.join("；");
  emit(state, "advance_shifts", summary);
  log(state, `${summary}。现金 ¥${state.cash}，声誉 ${state.reputation}。`, "info");
  return ok(
    `${summary}。现金 ¥${state.cash}，声誉 ${state.reputation}${state.gameOver ? "，工厂已破产" : ""}。` +
      (allCompleted.length ? `（${allCompleted.slice(0, 8).join("；")}${allCompleted.length > 8 ? " 等" : ""}）` : "")
  );
}

// 启动一项科技研发
export function research(state: GameState, nodeId: string): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const node = TECH_NODE[nodeId];
  if (!node) return fail(`未知科技 ${nodeId}。`);
  if (state.tech.researched.includes(nodeId)) return fail(`${node.name} 已研发完成。`);
  if (state.tech.researching) return fail(`正在研发 ${TECH_NODE[state.tech.researching.nodeId]?.name ?? state.tech.researching.nodeId}，需完成后再启动新项目。`);
  const missing = node.requires.filter((r) => !state.tech.researched.includes(r));
  if (missing.length) return fail(`${node.name} 的前置科技未满足：${missing.map((m) => TECH_NODE[m]?.name ?? m).join("、")}。`);
  if (state.cash < node.cost) return fail(`现金不足：研发 ${node.name} 需 ¥${node.cost}，仅余 ¥${state.cash}。`);
  state.cash -= node.cost;
  state.tech.researching = { nodeId, remaining: node.researchShifts, total: node.researchShifts };
  log(state, `启动研发【${node.name}】，投入 ¥${node.cost}，预计 ${node.researchShifts} 班次完成。效果：${node.desc}`, "info");
  emit(state, "research", `启动研发 ${node.name}`);
  return ok(`已启动研发 ${node.name}（投入 ¥${node.cost}，${node.researchShifts} 班次）。期间继续推进班次（factory_advance_shift 或 factory_advance_shifts）即可累计进度。`);
}

// 一键流水线：接下所有询价 → 全部设计 → 把待排产订单自动排到空闲机床 → 可选连续推进 N 班。
// 把模型容易"讲故事不执行"的多步组合压成一次工具调用（根治偷懒编造 + 多步截断）。
export function runPipeline(state: GameState, opts?: { advanceShifts?: number }): OpResult {
  if (state.gameOver) return fail("工厂已破产，请重置游戏。");
  const accepted: string[] = [];
  const designed: string[] = [];
  const scheduled: string[] = [];
  const blocked: string[] = [];

  for (const o of state.orders) {
    if (o.status === "inquiry") {
      const r = acceptInquiry(state, o.id);
      if (r.ok) accepted.push(o.id);
    }
  }
  for (const o of state.orders) {
    if (o.status === "accepted" || o.status === "designing") {
      const r = startDesign(state, o.id);
      if (r.ok) designed.push(o.id);
    }
  }
  // 每个待排产/加工中订单排一道工序到空闲机床（自动匹配机床类型）
  for (const o of state.orders) {
    if (o.status === "ready" || o.status === "in_production") {
      const r = scheduleJob(state, o.id);
      if (r.ok) scheduled.push(o.id);
      else blocked.push(`${o.id}（${r.message}）`);
    }
  }

  let advanced: string | null = null;
  const n = opts?.advanceShifts ?? 0;
  if (n > 0) advanced = advanceShifts(state, n).message;

  const parts: string[] = [];
  if (accepted.length) parts.push(`接单 ${accepted.length}（${accepted.join("、")}）`);
  if (designed.length) parts.push(`设计 ${designed.length}（${designed.join("、")}）`);
  if (scheduled.length) parts.push(`排产 ${scheduled.length}（${scheduled.join("、")}）`);
  if (blocked.length) parts.push(`未排产 ${blocked.length}（${blocked[0]}${blocked.length > 1 ? " 等" : ""}）`);
  if (advanced) parts.push(advanced);
  const summary = parts.length ? parts.join("；") : "无待处理的询价/排产任务。";
  log(state, `【流水线】${summary}`, "info");
  emit(state, "run_pipeline", summary);
  return ok(`流水线执行完成：${summary} 现金 ¥${state.cash}，声誉 ${state.reputation}${state.gameOver ? "，工厂已破产" : ""}。`);
}

// ---- 事件生成 ----

function spawnRandomEvent(state: GameState, eff: ReturnType<typeof getTechEffects>): boolean {
  // 控制活动事件数量
  const active = state.events.filter((e) => !e.resolved);
  if (active.length >= 3) return false;
  let types: GameEvent["type"][] = ["machine_breakdown", "rush_order", "material_delay", "customer_urge"];
  if (eff.preventBreakdown) types = types.filter((t) => t !== "machine_breakdown");
  if (eff.preventMaterialDelay) types = types.filter((t) => t !== "material_delay");
  if (!types.length) return false;
  const type = types[Math.floor(Math.random() * types.length)];
  const id = `E-${state.shift}-${Math.floor(Math.random() * 900 + 100)}`;
  let ev: GameEvent;
  switch (type) {
    case "machine_breakdown": {
      const running = state.machines.filter((m) => m.status === "running");
      const m = running[Math.floor(Math.random() * running.length)];
      if (!m) return false; // 没有运行机床就跳过
      m.status = "broken";
      ev = { id, type, shift: state.shift, title: "设备故障", detail: `${m.name} 突发故障停机，在制工序暂停。`, resolved: false, payload: { machineId: m.id } };
      break;
    }
    case "rush_order": {
      ev = { id, type, shift: state.shift, title: "紧急插单", detail: "客户加急下单，溢价 30%，是否接？", resolved: false };
      break;
    }
    case "material_delay": {
      const grades = ["P20", "718H", "S136"];
      const grade = grades[Math.floor(Math.random() * grades.length)];
      ev = { id, type, shift: state.shift, title: "钢料延迟", detail: `供应商通知 ${grade} 到货延迟，加急 ¥8000 或等待（库存 -10）。`, resolved: false, payload: { grade } };
      break;
    }
    case "customer_urge": {
      const pending = state.orders.filter((o) => ["in_production", "trial_pending", "ready"].includes(o.status));
      const o = pending[Math.floor(Math.random() * pending.length)];
      if (!o) return false;
      ev = { id, type, shift: state.shift, title: "客户催货", detail: `${o.customer} 催促订单 ${o.id} 进度。`, resolved: false, payload: { orderId: o.id } };
      break;
    }
  }
  state.events.unshift(ev);
  log(state, `【事件】${ev.title}：${ev.detail}`, "warn");
  return true;
}

// ---- 工具函数 ----

function ok(message: string, data?: Record<string, any>): OpResult {
  return { ok: true, message, data };
}
function fail(message: string): OpResult {
  return { ok: false, message };
}
