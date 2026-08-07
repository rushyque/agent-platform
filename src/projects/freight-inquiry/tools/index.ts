// Tool aggregation: 4 resource-based business tools + coreTools.
// Business tools reduced from 17 to 4 via mode dispatch.
import type { ToolDefinition } from '../../../types/agent-config.js';
import { coreTools } from '../../../core/tools/index.js';
import { inquiryTool } from './inquiry.js';
import { emailTool } from './email.js';
import { quoteTool } from './ai.js';
import { decisionTool } from './decision.js';

export { inquiryTool, emailTool, quoteTool, decisionTool };

export const freightInquiryTools: ToolDefinition[] = [
  inquiryTool, // create/list/view/set_preference/list_forwarders (5 modes)
  emailTool, // dispatch/collect/view (3 modes)
  quoteTool, // parse/evaluate/view_comparison/view_recommendation (4 modes)
  decisionTool, // notify_review/review/negotiate/record/confirm (5 modes)
  // coreTools (observe_state needs getState from resolveContext; rest zero-config)
  coreTools.observeState,
  coreTools.now,
  coreTools.recall,
  coreTools.setNote,
  coreTools.getNote,
  coreTools.confirm,
];
