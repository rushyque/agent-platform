// 星联模具工厂 —— 初始世界数据与工厂初始化。
import type {
  MoldType,
  MoldSpec,
  Machine,
  MaterialStock,
  Order,
  GameState,
} from "./types.js";

// 模具产品规格：工艺路线 / 钢料 / 基准价
export const MOLD_SPECS: Record<MoldType, MoldSpec> = {
  blow_mold: {
    type: "blow_mold",
    routing: ["rough_cnc", "finish_cnc", "edm", "polish", "assembly"],
    steelGrade: "S136",
    basePrice: 480000,
  },
  preform_mold: {
    type: "preform_mold",
    routing: ["finish_cnc", "edm", "assembly"],
    steelGrade: "718H",
    basePrice: 260000,
  },
  cap_mold: {
    type: "cap_mold",
    routing: ["finish_cnc", "assembly"],
    steelGrade: "P20",
    basePrice: 90000,
  },
};

// 每套模具所需钢料块数
export const STEEL_PER_QTY: Record<MoldType, number> = {
  blow_mold: 4,
  preform_mold: 2,
  cap_mold: 1,
};

// 客户池（饮料/食品品牌，星联真实客群风格）
export const CUSTOMER_POOL = [
  "农夫山泉",
  "可口可乐",
  "华润怡宝",
  "康师傅",
  "达能",
  "百事",
  "加多宝",
  "今麦郎",
  "统一",
  "王老吉",
];

// 机床名册
function rosterMachine(id: string, name: string, type: Machine["type"], speed: number): Machine {
  return { id, name, type, status: "idle", speed };
}

export function initialMachines(): Machine[] {
  return [
    rosterMachine("M-CNC-01", "1号CNC加工中心", "cnc_mill", 1.0),
    rosterMachine("M-CNC-02", "2号CNC加工中心", "cnc_mill", 1.1),
    rosterMachine("M-CNC-03", "3号CNC加工中心", "cnc_mill", 0.9),
    rosterMachine("M-EDM-01", "1号EDM火花机", "edm", 1.0),
    rosterMachine("M-EDM-02", "2号EDM火花机", "edm", 0.95),
    rosterMachine("M-WC-01", "1号线切割", "wire_cut", 1.0),
    rosterMachine("M-TRIAL-01", "1号试模注塑机", "trial_injector", 1.0),
  ];
}

export function initialInventory(): MaterialStock[] {
  return [
    { grade: "P20", qty: 200 },
    { grade: "718H", qty: 120 },
    { grade: "S136", qty: 60 },
  ];
}

// 估算某订单总工时（班次），用于设定交期
export function estimateRoutingTime(moldType: MoldType, qty: number): number {
  const spec = MOLD_SPECS[moldType];
  // 粗略：每工序工时之和 × qty，不考虑并行（保守估计）
  const perStep = { rough_cnc: 2, finish_cnc: 3, edm: 2, wire_cut: 2, polish: 1, assembly: 1 };
  const total = spec.routing.reduce((sum, p) => sum + perStep[p] * qty, 0);
  return total;
}

// 生成一个询价订单（供初始世界与后续插单）
export function generateInquiry(
  seqRef: { seq: number },
  shift: number,
  opts?: { rush?: boolean; moldType?: MoldType }
): Order {
  const moldTypes: MoldType[] = ["blow_mold", "preform_mold", "cap_mold"];
  const moldType = opts?.moldType ?? moldTypes[Math.floor(Math.random() * moldTypes.length)];
  const spec = MOLD_SPECS[moldType];
  const qty = 1 + Math.floor(Math.random() * 3); // 1~3 套
  const base = spec.basePrice * qty * (opts?.rush ? 1.3 : 1.0);
  const price = Math.round(base / 1000) * 1000;
  const penalty = Math.round(price * 0.1 / 1000) * 1000;
  const estTime = estimateRoutingTime(moldType, qty);
  const buffer = 3 + Math.floor(Math.random() * 4); // 3~6 班次缓冲
  const customer = CUSTOMER_POOL[Math.floor(Math.random() * CUSTOMER_POOL.length)];
  const id = `O-${String(seqRef.seq).padStart(4, "0")}`;
  seqRef.seq += 1;
  return {
    id,
    customer,
    moldType,
    qty,
    price,
    dueShift: shift + estTime + buffer,
    penalty,
    rush: opts?.rush ?? false,
    status: "inquiry",
    steps: [],
  };
}

export function createInitialState(userId: string): GameState {
  const seqRef = { seq: 1 };
  const orders: Order[] = [
    generateInquiry(seqRef, 0, { moldType: "blow_mold" }),
    generateInquiry(seqRef, 0, { moldType: "preform_mold" }),
    generateInquiry(seqRef, 0, { moldType: "cap_mold" }),
  ];
  return {
    userId,
    factoryName: "星联精密 · PET吹瓶模智能工厂（佛山）",
    shift: 0,
    cash: 1_200_000,
    reputation: 70,
    machines: initialMachines(),
    inventory: initialInventory(),
    orders,
    events: [],
    log: [
      {
        shift: 0,
        text: "工厂开工。车间 7 台设备就位，3 张询价单待接。",
        kind: "info",
      },
    ],
    tech: { researched: [] },
    gameOver: false,
    seq: seqRef.seq,
  };
}
