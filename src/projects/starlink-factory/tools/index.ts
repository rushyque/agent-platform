// 工具聚合：导出星联模具工厂的全部工具与列表。
import type { ToolDefinition } from "../../../types/agent-config.js";
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
  advanceShiftTool,
  advanceShiftsTool,
  runPipelineTool,
  listEventsTool,
  handleEventTool,
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
  advanceShiftTool,
  advanceShiftsTool,
  runPipelineTool,
  listEventsTool,
  handleEventTool,
  resetGameTool,
};

export const factoryTools: ToolDefinition[] = [
  viewDashboardTool,
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
  resetGameTool,
];
