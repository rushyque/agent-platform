import { z } from "zod";

// =============================================================================
// 中台通用渲染契约（render block）
//
// 业务无关、样式无关的结构化"内容块"：模型 / 工具把想呈现的互动与内容结构化
// 成一个 blocks 数组，任何前端都能按 block.kind 映射到自己的组件（表格、卡片、
// 图表、Mermaid、文档、选项、Markdown 等），样式完全由前端决定。
//
// 传递方式（与既有 show_ui 同一套）：
//   render 工具返回 { ui: { type: "render", blocks }, hint }；
//   工具结果经 artifact 外置，summary 带精简文本，ref 供前端拉取完整 blocks。
// =============================================================================

// -- 单个选项（choices / 表单用）--
export const choiceSchema = z.object({
  label: z.string().describe("选项显示文本"),
  value: z.string().describe("点击后发给模型的取值"),
  style: z
    .enum(["default", "primary", "success", "warning", "danger"])
    .optional()
    .describe("提示性样式，前端可按自己设计取舍"),
});
export type Choice = z.infer<typeof choiceSchema>;

// -- 表格 --
export const tableBlockSchema = z.object({
  kind: z.literal("table"),
  title: z.string().optional(),
  columns: z
    .array(
      z.object({
        key: z.string().describe("列取值字段"),
        label: z.string().describe("列头显示名"),
        width: z.string().optional().describe("可选宽度，如 '120px'"),
        align: z.enum(["left", "center", "right"]).optional(),
      })
    )
    .min(1),
  rows: z.array(z.record(z.any())).describe("每行一个对象，键对应 columns[].key"),
});
export type TableBlock = z.infer<typeof tableBlockSchema>;

// -- 指标卡片 --
export const cardSchema = z.object({
  title: z.string(),
  value: z.union([z.string(), z.number()]),
  subtitle: z.string().optional(),
  icon: z.string().optional().describe("图标名，前端有 icon 库则用，否则忽略"),
  tone: z
    .enum(["default", "positive", "warning", "negative"])
    .optional()
    .describe("语义色，前端可按设计取舍"),
});
const cardsBlockSchema = z.object({
  kind: z.literal("cards"),
  title: z.string().optional(),
  cards: z.array(cardSchema).min(1),
});

// -- 图表 --
export const chartSeriesSchema = z.object({
  name: z.string(),
  data: z.array(z.number()),
});
const chartBlockSchema = z.object({
  kind: z.literal("chart"),
  title: z.string().optional(),
  type: z.enum(["bar", "line", "pie", "area"]),
  xAxis: z.array(z.union([z.string(), z.number()])).optional(),
  series: z.array(chartSeriesSchema).min(1),
});

// -- Mermaid 图 --
const mermaidBlockSchema = z.object({
  kind: z.literal("mermaid"),
  title: z.string().optional(),
  code: z.string().describe("完整的 mermaid 源码，如 graph TD; ..."),
});

// -- 结构化文档 --
const documentSectionSchema = z.object({
  heading: z.string().optional(),
  paragraphs: z.array(z.string()).optional(),
  bullets: z.array(z.string()).optional(),
});
const documentBlockSchema = z.object({
  kind: z.literal("document"),
  title: z.string().optional(),
  sections: z.array(documentSectionSchema),
});

// -- 用户选项（像 Claude 的选择按钮）--
const choicesBlockSchema = z.object({
  kind: z.literal("choices"),
  prompt: z.string().optional(),
  choices: z.array(choiceSchema).min(1).max(6),
});

// -- 纯 Markdown 文本 --
const markdownBlockSchema = z.object({
  kind: z.literal("markdown"),
  markdown: z.string(),
});

// -- 跳转链接 --
const linkBlockSchema = z.object({
  kind: z.literal("link"),
  url: z.string(),
  label: z.string(),
  mode: z.enum(["auto", "tab", "navigate"]).optional(),
});

// -- 通知 (toast) --
const notifyBlockSchema = z.object({
  kind: z.literal("notify"),
  message: z.string(),
  level: z.enum(["info", "success", "warning", "error"]).optional(),
});

// 标准 render block（联合 schema）
export const renderBlockSchema = z.discriminatedUnion("kind", [
  tableBlockSchema,
  cardsBlockSchema,
  chartBlockSchema,
  mermaidBlockSchema,
  documentBlockSchema,
  choicesBlockSchema,
  markdownBlockSchema,
  linkBlockSchema,
  notifyBlockSchema,
]);

export type RenderBlock = z.infer<typeof renderBlockSchema>;
export type RenderBlockKind = RenderBlock["kind"];

// 每一个 kind 允许的最小/最大 blocks 数（给模型一个直觉，也用于校验提示）
export const RENDER_KIND_LABELS: Record<RenderBlockKind, string> = {
  table: "数据表格",
  cards: "指标卡片",
  chart: "图表（bar/line/pie/area）",
  mermaid: "Mermaid 图",
  document: "结构化文档",
  choices: "用户选项按钮",
  markdown: "Markdown 文本",
  link: "跳转链接",
  notify: "页面通知(toast)",
};

// 校验并规范化一个 blocks 数组：抛错则说明调用方参数不合法。
// 返回的数组保证每项都是合法 RenderBlock。
export function validateBlocks(input: unknown): RenderBlock[] {
  if (!Array.isArray(input)) {
    throw new Error("render blocks 必须是一个数组");
  }
  if (input.length === 0) {
    throw new Error("render blocks 不能为空");
  }
  if (input.length > 16) {
    throw new Error("render blocks 一次最多 16 个");
  }
  return input.map((b, i) => {
    try {
      return renderBlockSchema.parse(b);
    } catch (e) {
      throw new Error(`render blocks[${i}] 不合法: ${(e as z.ZodError).message}`);
    }
  });
}
