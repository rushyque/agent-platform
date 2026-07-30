// 工具聚合：导出星联模具工厂的全部工具与列表。
import type { ToolDefinition } from "../../../types/agent-config.js";
import { coreTools } from "../../../core/tools/index.js";
import { listOrdersTool, orderDetailTool, acceptInquiryTool, deliverOrderTool } from "./orders.js";
import { startDesignTool, scheduleJobTool, unscheduleJobTool, runTrialTool } from "./production.js";
import {
  viewWorkshopTool,
  viewScheduleTool,
  viewInventoryTool,
  purchaseMaterialTool,
} from "./workshop.js";
import {
  viewDashboardTool,
  factoryShiftReportTool,
  advanceShiftTool,
  advanceShiftsTool,
  runPipelineTool,
  listEventsTool,
  handleEventTool,
  listTechTool,
  researchTool,
  resetGameTool,
} from "./ops.js";

export {
  listOrdersTool,
  orderDetailTool,
  acceptInquiryTool,
  deliverOrderTool,
  startDesignTool,
  scheduleJobTool,
  unscheduleJobTool,
  runTrialTool,
  viewWorkshopTool,
  viewScheduleTool,
  viewInventoryTool,
  purchaseMaterialTool,
  viewDashboardTool,
  factoryShiftReportTool,
  advanceShiftTool,
  advanceShiftsTool,
  runPipelineTool,
  listEventsTool,
  handleEventTool,
  listTechTool,
  researchTool,
  resetGameTool,
};

export const factoryTools: ToolDefinition[] = [
  viewDashboardTool,
  factoryShiftReportTool,
  listOrdersTool,
  orderDetailTool,
  acceptInquiryTool,
  startDesignTool,
  scheduleJobTool,
  unscheduleJobTool,
  viewWorkshopTool,
  viewScheduleTool,
  viewInventoryTool,
  purchaseMaterialTool,
  runTrialTool,
  deliverOrderTool,
  advanceShiftTool,
  advanceShiftsTool,
  runPipelineTool,
  listEventsTool,
  handleEventTool,
  listTechTool,
  researchTool,
  resetGameTool,
  // 中台通用工具（observe_state 需 resolveContext 的 getState/formatTime，已注入；其余零接线）
  coreTools.observeState,
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];
