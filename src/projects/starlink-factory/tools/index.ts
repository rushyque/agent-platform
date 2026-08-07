// Tool aggregation: 4 resource-based business tools + coreTools.
// Business tools reduced from 22 to 4 via mode dispatch.
import type { ToolDefinition } from "../../../types/agent-config.js";
import { coreTools } from "../../../core/tools/index.js";
import { orderTool, MOLD_LABEL } from "./orders.js";
import { productionTool } from "./production.js";
import { workshopTool } from "./workshop.js";
import { factoryTool } from "./ops.js";

export { orderTool, productionTool, workshopTool, factoryTool, MOLD_LABEL };

export const factoryTools: ToolDefinition[] = [
  factoryTool, // dashboard/shift/advance/events/tech/pipeline/reset (10 modes)
  orderTool, // list/detail/accept/deliver (4 modes)
  productionTool, // design/schedule/unschedule/trial (4 modes)
  workshopTool, // view_machines/view_schedule/view_inventory/purchase (4 modes)
  // coreTools (observe_state needs getState/formatTime from agent-config; show_ui needs domMap)
  coreTools.showUi,
  coreTools.observeState,
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];
