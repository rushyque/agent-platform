import { validateBlocks, type RenderBlock } from "./contract.js";

// 从助手文本流中解析"第一等"渲染块：模型在正常输出里用 <render>{json}</render>
// 声明要渲染的内容，harness / 任何前端统一用本函数把它抽成 blocks。
//
// 这是 render 从"no-op 工具"升级为"结构化输出契约"后的解析端：
// 不依赖特定的工具槽（TOOL_CALL_RESULT），只依赖模型在文本里声明的标准块。
//
// 支持两种写法（宽松解析，方便模型与客户端）：
//   1. <render>{"table":...}/[ {...} ]</render>
//   2. 围栏块：```render+json ... ``` 或 RENDER_BLOCKS= {...}

const BLOCK_TAG_RE = /<render>([\s\S]*?)<\/render>/gi;
const FENCE_RE = /```render(?:\+json)?\s*\n?([\s\S]*?)\n?```/gi;
const ASSIGN_RE = /RENDER_BLOCKS\s*=\s*/i;

function tryParseJson(raw: string): RenderBlock[] | null {
  const t = raw.trim();
  if (!t) return null;
  // 尝试先把单个块包成数组
  const candidates = [t];
  if (!t.startsWith("[")) candidates.push(`[${t}]`);
  for (const c of candidates) {
    try {
      let parsed = JSON.parse(c);
      // 兼容三种外层形态：裸数组 / {"blocks":[...]} / {"ui":{"type":"render","blocks":[...]}}
      if (!Array.isArray(parsed)) {
        if (Array.isArray(parsed?.blocks)) parsed = parsed.blocks;
        else if (Array.isArray(parsed?.ui?.blocks)) parsed = parsed.ui.blocks;
      }
      return validateBlocks(parsed);
    } catch {
      // try next
    }
  }
  return null;
}

export function parseRenderBlocks(text: unknown): RenderBlock[] {
  if (typeof text !== "string" || !text) return [];
  const blocks: RenderBlock[] = [];
  const seen = new Set<string>();
  const push = (b: RenderBlock) => {
    const sig = JSON.stringify(b);
    if (!seen.has(sig)) {
      seen.add(sig);
      blocks.push(b);
    }
  };

  const scanCandidates: string[] = [];

  // 1) <render>...</render>
  let m = BLOCK_TAG_RE.exec(text);
  while (m) {
    scanCandidates.push(m[1]);
    m = BLOCK_TAG_RE.exec(text);
  }
  // 2) ```render ... ```
  let f = FENCE_RE.exec(text);
  while (f) {
    scanCandidates.push(f[1]);
    f = FENCE_RE.exec(text);
  }
  // 3) RENDER_BLOCKS= {json}
  const eq = text.split(ASSIGN_RE).slice(1);
  if (eq.length) scanCandidates.push(eq[0]);

  for (const cand of scanCandidates) {
    const arr = tryParseJson(cand);
    if (arr) arr.forEach(push);
  }

  return blocks;
}

// 把 blocks 序列化成模型可内联声明的 <render>...</render> 文本片段。
export function renderBlocksToText(blocks: RenderBlock[]): string {
  const arr = validateBlocks(blocks);
  return `<render>${JSON.stringify(arr)}</render>`;
}
