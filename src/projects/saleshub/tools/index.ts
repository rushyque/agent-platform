// SalesHub business tools + a curated subset of generic coreTools.
import type { ToolDefinition } from "../../../types/agent-config.js";
import { coreTools } from "../../../core/tools/index.js";
import { listRemittancesTool, remittanceStatsTool } from "./remittances.js";
import { listOrderRecordsTool, orderRecordDetailTool } from "./orderRecords.js";
import { reconReportTool } from "./recon.js";
import { navigateToTool } from "./navigateTo.js";
import {
  listVisitPlansTool,
  listVisitPlanRecipientsTool,
  sendVisitPlanEmailTool,
} from "./visitPlan.js";

export {
  listOrderRecordsTool,
  orderRecordDetailTool,
  listRemittancesTool,
  remittanceStatsTool,
  reconReportTool,
  listVisitPlansTool,
  listVisitPlanRecipientsTool,
  sendVisitPlanEmailTool,
};

export const salesHubTools: ToolDefinition[] = [
  listOrderRecordsTool,
  orderRecordDetailTool,
  listRemittancesTool,
  remittanceStatsTool,
  reconReportTool,
  listVisitPlansTool,
  listVisitPlanRecipientsTool,
  // 写操作：发送拜访计划邮件。fullModeOnly 标记使其仅在完全模式暴露。
  sendVisitPlanEmailTool,
  navigateToTool,
  coreTools.getPageState,
  coreTools.uiClick,
  coreTools.uiFill,
  // Generic primitives useful for a sales assistant.
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];
