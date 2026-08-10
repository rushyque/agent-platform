import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";
import { renderBlockSchema } from "./contract.js";
import { validateBlocks } from "./contract.js";
import { blocksToSummary } from "./summary.js";

// render —— 通用内容/互动渲染原语（业务无关，可选中级通道）。
//
// 定位：默认"文本内联 <render>{json}</render>"为第一等输出（见 server.ts 的
// STRUCTURED_OUTPUT_GUIDE），任何项目/前端都能消费，零截断、零额外工具往返。
// render 工具是可选的高级通道：仅当项目明确需要"中台侧强校验 schema / 可审计
// 的工具足迹 / 程序化产出 blocks"时才装配。两种通道共用同一 blocks 契约，
// 前端一个 dispatcher 即可处理。
//
// 与 show_ui 的分工：
//   show_ui -> 页面级轻动作（guide/notify/open_link）
//   render  -> 内容级渲染块（含 choices 选项，结构化回传见 handoff.ts）
// 两者共用同一 { ui: { type, ... } } 传输契约，前端一个 dispatcher 即可处理。

const renderBlocksSchema = z
  .array(renderBlockSchema)
  .min(1)
  .max(16)
  .describe(
    "要渲染的内容块数组。可一次给多个块按顺序展示（如先表格、再图表）。" +
      "kind 支持：table/cards/chart/mermaid/document/choices/markdown/link/notify。"
  );

export const renderTool: ToolDefinition = {
  name: "render",
  description:
    "（可选中级通道，通常不需要）把要呈现给用户的内容结构化为渲染块 (blocks) 输出，前端按 kind 渲染。\n" +
    "默认请直接在回复文本里用 <render>{json}</render> 声明，前端统一解析，不必调用本工具。\n" +
    "仅当项目明确要求经工具产出以便强校验/审计时，才调用本工具。\n" +
    "kind 一览：\n" +
    "- table：数据表格（columns + rows）\n" +
    "- cards：指标卡片（title/value/subtitle/icon/tone）\n" +
    "- chart：图表（bar/line/pie/area，xAxis + series）\n" +
    "- mermaid：Mermaid 图（code）\n" +
    "- document：结构化文档（sections: heading/paragraphs/bullets）\n" +
    "- choices：用户选择按钮（prompt + choices，像 Claude 的选项）\n" +
    "- markdown：Markdown 文本\n" +
    "- link：跳转链接（url/label/mode）\n" +
    "- notify：页面通知 toast（message/level）\n" +
    "一次可给多个块按展示顺序排列（如先 cards 总览、再 table 明细）。",
  parameters: z.object({
    blocks: renderBlocksSchema,
  }),
  readonly: true,
  execute: async (args: any, _context: AgentContext) => {
    const blocks = validateBlocks(args.blocks);
    const hint = blocksToSummary(blocks);
    // ui 承载完整 blocks，前端据此渲染；hint 是给模型与工具卡的文本预览。
    // 注意不要用 trace/summary/message/error/detail/data 这些 summarizeToolResult 的
    // 保留字段承载 blocks，否则会被截断而丢失到前端。
    return {
      ok: true,
      ui: { type: "render", blocks },
      hint,
    };
  },
};
