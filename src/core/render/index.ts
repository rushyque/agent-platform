export {
  renderBlockSchema,
  choiceSchema,
  validateBlocks,
  RENDER_KIND_LABELS,
  type RenderBlock,
  type RenderBlockKind,
  type Choice,
  type TableBlock,
} from "./contract.js";
export { blocksToSummary } from "./summary.js";
export { renderTool } from "./tool.js";
export { parseRenderBlocks, renderBlocksToText } from "./parse.js";
export {
  buildChoiceSelection,
  parseChoiceSelection,
  choiceToPrompt,
  normalizeChoiceResponse,
  type ChoiceSelection,
} from "./handoff.js";
