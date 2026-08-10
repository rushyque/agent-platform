import type { RenderBlock } from "./contract.js";

// 把 render blocks 压成一行/几行的精简摘要，给模型与 hint 用。
// 前端不依赖这份文本（它拉取完整 blocks 渲染）；这只是让模型"看见"自己产出了什么。
export function blocksToSummary(blocks: RenderBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "markdown":
        lines.push(`◆ markdown：${b.markdown.slice(0, 60)}`);
        break;
      case "choices":
        lines.push(`◆ choices：${b.prompt || ""} [${b.choices.map((c) => c.label).join("/")}]`);
        break;
      case "table":
        lines.push(
          `◆ table${b.title ? ` ${b.title}` : ""}：${b.columns.length} 列 × ${b.rows.length} 行`
        );
        break;
      case "cards":
        lines.push(
          `◆ cards${b.title ? ` ${b.title}` : ""}：${b.cards
            .map((c) => `${c.title}=${c.value}`)
            .join(", ")}`
        );
        break;
      case "chart":
        lines.push(
          `◆ chart${b.title ? ` ${b.title}` : ""}：${b.type}，${b.series
            .map((s) => `${s.name}[${s.data.length}]`)
            .join(", ")}`
        );
        break;
      case "mermaid":
        lines.push(`◆ mermaid${b.title ? ` ${b.title}` : ""}：${b.code.length} 字符图`);
        break;
      case "document":
        lines.push(
          `◆ document${b.title ? ` ${b.title}` : ""}：${b.sections.length} 节`
        );
        break;
      case "link":
        lines.push(`◆ link：${b.label} -> ${b.url}`);
        break;
      case "notify":
        lines.push(`◆ notify[${b.level || "info"}]：${b.message}`);
        break;
    }
  }
  return lines.join("\n");
}
