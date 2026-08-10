// SalesHub business tools + a curated subset of generic coreTools.
import type { ToolDefinition } from "../../../types/agent-config.js";
import { coreTools } from "../../../core/tools/index.js";
import { listOrdersTool, orderDetailTool, orderStatsTool } from "./orders.js";
import { listCustomersTool, customerDetailTool } from "./customers.js";
import { listRemittancesTool } from "./remittances.js";

export { listOrdersTool, orderDetailTool, orderStatsTool, listCustomersTool, customerDetailTool, listRemittancesTool };

export const salesHubTools: ToolDefinition[] = [
  listOrdersTool,
  orderDetailTool,
  orderStatsTool,
  listCustomersTool,
  customerDetailTool,
  listRemittancesTool,
  // Generic primitives useful for a sales assistant.
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];
