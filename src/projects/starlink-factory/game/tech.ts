// 星联模具工厂 —— 科技与升级树。
// 给长期经营一条成长曲线与资金出口。节点定义 + 效果解析。
import type { GameState } from "./types.js";

export type TechCategory = "process" | "equipment" | "quality" | "management";

export interface TechNode {
  id: string;
  name: string;
  category: TechCategory;
  cost: number; // 研发投入（¥）
  researchShifts: number; // 研究所需班次
  requires: string[]; // 前置节点 id
  desc: string; // 效果描述（人/模型可读）
}

export const TECH_CATEGORY_LABEL: Record<TechCategory, string> = {
  process: "工艺",
  equipment: "设备",
  quality: "质量",
  management: "管理",
};

export const TECH_TREE: TechNode[] = [
  // 工艺
  { id: "wire_preproc", name: "线切割预处理", category: "process", cost: 60000, researchShifts: 3, requires: [], desc: "CNC 工序质量 +3。" },
  { id: "mirror_polish", name: "镜面抛光", category: "process", cost: 120000, researchShifts: 4, requires: ["wire_preproc"], desc: "抛光工序质量 +8。" },
  { id: "multi_cavity", name: "多腔模具技术", category: "process", cost: 200000, researchShifts: 6, requires: ["mirror_polish"], desc: "所有机床有效速度 +0.1。" },
  // 设备
  { id: "cnc_upgrade", name: "CNC高速主轴", category: "equipment", cost: 80000, researchShifts: 3, requires: [], desc: "CNC 加工中心速度 +0.15。" },
  { id: "edm_upgrade", name: "EDM精密电源", category: "equipment", cost: 100000, researchShifts: 4, requires: ["cnc_upgrade"], desc: "EDM 火花机速度 +0.15。" },
  { id: "automation", name: "自动化产线", category: "equipment", cost: 300000, researchShifts: 8, requires: ["cnc_upgrade", "edm_upgrade"], desc: "所有机床有效速度 +0.2（需 CNC+EDM 升级）。" },
  { id: "predictive_maint", name: "预测性维护", category: "equipment", cost: 90000, researchShifts: 3, requires: [], desc: "彻底消除设备故障事件。" },
  // 质量
  { id: "qms", name: "质量管理体系", category: "quality", cost: 70000, researchShifts: 3, requires: [], desc: "全部加工工序质量 +4。" },
  { id: "spc", name: "统计过程控制", category: "quality", cost: 130000, researchShifts: 5, requires: ["qms"], desc: "试模合格门槛 78 → 74。" },
  { id: "trial_sim", name: "试模仿真", category: "quality", cost: 180000, researchShifts: 6, requires: ["spc"], desc: "试模质量噪声减半，结果更稳。" },
  // 管理
  { id: "lean", name: "精益生产", category: "management", cost: 60000, researchShifts: 3, requires: [], desc: "每班次固定开支 8000 → 6000。" },
  { id: "smed", name: "快速换模(SMED)", category: "management", cost: 110000, researchShifts: 4, requires: ["lean"], desc: "上料工时 -1（最低 1 班）。" },
  { id: "supply_chain", name: "供应链优化", category: "management", cost: 100000, researchShifts: 4, requires: ["lean"], desc: "消除钢料延迟事件；采购 9 折。" },
];

export const TECH_NODE: Record<string, TechNode> = Object.fromEntries(
  TECH_TREE.map((n) => [n.id, n])
);

// 已研发节点 → 扁平 bonus，供引擎各计算点读取
export interface TechEffects {
  cncSpeedBonus: number; // 加到 cnc_mill speed
  edmSpeedBonus: number; // 加到 edm speed
  globalSpeedBonus: number; // 加到所有机床 speed（multi_cavity + automation）
  trialThreshold: number; // 试模合格线
  trialNoise: number; // 试模质量噪声幅度（±）
  qualityBonus: number; // 全局加工质量加成（qms）
  cncQualityBonus: number; // CNC 工序质量加成（wire_preproc）
  polishQualityBonus: number; // 抛光工序质量加成（mirror_polish）
  overhead: number; // 每班固定开支（lean）
  scheduleTimeBonus: number; // 上料工时减免（smed）
  materialDiscount: number; // 采购折扣（supply_chain）
  preventBreakdown: boolean; // 预测性维护
  preventMaterialDelay: boolean; // 供应链优化
}

export function getTechEffects(state: GameState): TechEffects {
  const r = new Set(state.tech.researched);
  return {
    cncSpeedBonus: r.has("cnc_upgrade") ? 0.15 : 0,
    edmSpeedBonus: r.has("edm_upgrade") ? 0.15 : 0,
    globalSpeedBonus: (r.has("multi_cavity") ? 0.1 : 0) + (r.has("automation") ? 0.2 : 0),
    trialThreshold: r.has("spc") ? 74 : 78,
    trialNoise: r.has("trial_sim") ? 5 : 10,
    qualityBonus: r.has("qms") ? 4 : 0,
    cncQualityBonus: r.has("wire_preproc") ? 3 : 0,
    polishQualityBonus: r.has("mirror_polish") ? 8 : 0,
    overhead: r.has("lean") ? 6000 : 8000,
    scheduleTimeBonus: r.has("smed") ? 1 : 0,
    materialDiscount: r.has("supply_chain") ? 0.1 : 0,
    preventBreakdown: r.has("predictive_maint"),
    preventMaterialDelay: r.has("supply_chain"),
  };
}

export type NodeStatus = "researched" | "researching" | "available" | "locked";

export function nodeStatus(state: GameState, nodeId: string): NodeStatus {
  const node = TECH_NODE[nodeId];
  if (!node) return "locked";
  if (state.tech.researched.includes(nodeId)) return "researched";
  if (state.tech.researching?.nodeId === nodeId) return "researching";
  if (node.requires.every((req) => state.tech.researched.includes(req))) return "available";
  return "locked";
}
