// 星联模具工厂 —— 游戏数据模型类型。
// 以 PET 食品饮料包装模具厂（吹瓶模/注坯模/瓶盖模）为原型的虚构模拟。

// 模具类型
export type MoldType = "blow_mold" | "preform_mold" | "cap_mold";

export const MOLD_LABEL: Record<MoldType, string> = {
  blow_mold: "PET吹瓶模",
  preform_mold: "注坯模",
  cap_mold: "瓶盖模",
};

// 工序类型
export type ProcessType =
  | "rough_cnc" // 粗加工CNC
  | "finish_cnc" // 精加工CNC
  | "edm" // EDM 火花机
  | "wire_cut" // 线切割
  | "polish" // 抛光（手工工位）
  | "assembly"; // 装配（手工工位）

export const PROCESS_LABEL: Record<ProcessType, string> = {
  rough_cnc: "粗加工CNC",
  finish_cnc: "精加工CNC",
  edm: "EDM火花",
  wire_cut: "线切割",
  polish: "抛光",
  assembly: "装配",
};

// 机床类型
export type MachineType = "cnc_mill" | "edm" | "wire_cut" | "trial_injector";

export const MACHINE_TYPE_LABEL: Record<MachineType, string> = {
  cnc_mill: "CNC加工中心",
  edm: "EDM火花机",
  wire_cut: "线切割",
  trial_injector: "试模注塑机",
};

// 工序所需机床类型；null 表示手工工位，不占机床
export const PROCESS_MACHINE: Record<ProcessType, MachineType | null> = {
  rough_cnc: "cnc_mill",
  finish_cnc: "cnc_mill",
  edm: "edm",
  wire_cut: "wire_cut",
  polish: null,
  assembly: null,
};

export type MachineStatus = "idle" | "running" | "maintenance" | "broken";

export interface Machine {
  id: string; // "M-CNC-01"
  name: string; // "1号CNC加工中心"
  type: MachineType;
  status: MachineStatus;
  speed: number; // 速度系数 0.8~1.2
  orderId?: string; // 当前承接的订单
  remaining?: number; // 当前作业剩余班次
  total?: number; // 当前作业总班次（进度条）
}

export interface MaterialStock {
  grade: string; // "P20" / "718H" / "S136"
  qty: number; // 块
}

export interface ProcessStep {
  process: ProcessType;
  status: "pending" | "running" | "done";
  machineId?: string;
  remaining?: number; // 运行中剩余班次
  total?: number; // 运行中总班次
  quality?: number; // 完成后记录的质量分 0-100
}

export type OrderStatus =
  | "inquiry" // 询价（待接单）
  | "accepted" // 已接单，待设计
  | "designing" // 设计中
  | "ready" // 设计完成，待排产
  | "in_production" // 加工中
  | "trial_pending" // 待试模
  | "delivered" // 已交付
  | "overdue"; // 逾期

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  inquiry: "询价",
  accepted: "已接单",
  designing: "设计中",
  ready: "待排产",
  in_production: "加工中",
  trial_pending: "待试模",
  delivered: "已交付",
  overdue: "逾期",
};

export interface Order {
  id: string; // "O-2607-001"
  customer: string;
  moldType: MoldType;
  qty: number; // 套数（影响工时）
  price: number; // 报价（¥）
  dueShift: number; // 交期班次
  penalty: number; // 逾期罚金
  rush: boolean; // 紧急单
  status: OrderStatus;
  steps: ProcessStep[]; // 设计完成后填入
  steelGrade?: string;
  steelNeeded?: number;
  steelConsumed?: boolean;
  acceptedAtShift?: number;
  deliveredAtShift?: number;
  lateCharged?: boolean; // 逾期罚金是否已计（只扣一次）
  trialPassed?: boolean;
  designQuality?: number; // 设计水平 0-100
}

export type GameEventType = "machine_breakdown" | "rush_order" | "material_delay" | "customer_urge";

export const EVENT_TYPE_LABEL: Record<GameEventType, string> = {
  machine_breakdown: "设备故障",
  rush_order: "紧急插单",
  material_delay: "钢料延迟",
  customer_urge: "客户催货",
};

export interface GameEvent {
  id: string;
  type: GameEventType;
  shift: number;
  title: string;
  detail: string;
  resolved: boolean;
  payload?: Record<string, any>;
}

export interface LogEntry {
  shift: number;
  text: string;
  kind: "info" | "good" | "warn" | "bad";
}

export interface TechState {
  researched: string[]; // 已完成节点 id
  researching?: { nodeId: string; remaining: number; total: number };
}

export interface GameState {
  userId: string;
  factoryName: string;
  shift: number;
  cash: number;
  reputation: number; // 0-100
  machines: Machine[];
  inventory: MaterialStock[];
  orders: Order[];
  events: GameEvent[];
  log: LogEntry[];
  tech: TechState;
  gameOver: boolean;
  seq: number; // 自增序号，用于生成 id
}

// 模具产品规格：工艺路线 / 工时 / 钢料 / 基准价
export interface MoldSpec {
  type: MoldType;
  routing: ProcessType[];
  steelGrade: string;
  basePrice: number;
}

// 每工序基准工时（班次，speed=1.0，qty=1）
export const BASE_STEP_TIME: Record<ProcessType, number> = {
  rough_cnc: 2,
  finish_cnc: 3,
  edm: 2,
  wire_cut: 2,
  polish: 1,
  assembly: 1,
};

// 钢料单价（¥/块）
export const STEEL_PRICE: Record<string, number> = {
  P20: 1800,
  "718H": 3200,
  S136: 5200,
};
