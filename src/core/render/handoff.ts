import type { Message } from "@ag-ui/core";

// 用户选择（choices）的"工具交接"契约。
//
// 前端渲染 choices 块后，用户点击某个选项，不应该把裸文本当普通消息回传
// （那样模型只能靠回显猜），而要带一个结构化的选择标记。中台在下一轮把
// 该标记改写成明确的 typed 输入，让模型确定知道"用户选了哪个 option"。

export interface ChoiceSelection {
  /** 选择的 value（choices[].value） */
  value: string;
  /** 选择的显示文本（choices[].label），用于可读回显 */
  label?: string;
  /** 可选：choiceId，用于跨轮区分同一线程的多次选择 */
  choiceId?: string;
}

// 前端把选择序列化成这条消息的 content。用窄字符避免与用户正文混淆。
export function buildChoiceSelection(sel: ChoiceSelection): string {
  const parts = [
    "CHOICE_SELECT",
    `value=${JSON.stringify(sel.value)}`,
    sel.label != null ? `label=${JSON.stringify(sel.label)}` : "",
    sel.choiceId != null ? `id=${JSON.stringify(sel.choiceId)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<${parts} />`;
}

const CHOICE_RE = /^<CHOICE_SELECT value=("[^"]*"|'[^']*')\s*(label=("[^"]*"|'[^']*'))?\s*(id=("[^"]*"|'[^']*'))?\s*\/>\s*$/;

// 解析一条用户消息是否携带选择交接，成功则返回结构化选择。
export function parseChoiceSelection(content: string): ChoiceSelection | null {
  if (typeof content !== "string") return null;
  const m = content.match(CHOICE_RE);
  if (!m) return null;
  const unq = (s?: string) =>
    s ? s.replace(/^["']|["']$/g, "") : undefined;
  return {
    value: unq(m[1]) ?? "",
    label: unq(m[3]),
    choiceId: unq(m[5]),
  };
}

// 把一个选择改写成模型能读懂的 typed 用户输入。
export function choiceToPrompt(sel: ChoiceSelection): string {
  const label = sel.label || sel.value;
  return `[用户在选择按钮中选择了：${label}（value=${sel.value}）]`;
}

export interface ChoiceNormalizationResult {
  messages: Message[];
  choice: ChoiceSelection | null;
}

// 归一化一整个 messages 数组：若最后一条用户消息是选择交接，则原地改写成
// 类型化文本，供 convertMessagesToVercelAISDKMessages / prompt 层使用。
// 返回 { messages, choice } —— choice 表示是否命中并给出结构化选择。
export function normalizeChoiceResponse(messages: Message[]): ChoiceNormalizationResult {
  const out: Message[] = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg && msg.role === "user" && typeof msg.content === "string") {
      const sel = parseChoiceSelection(msg.content);
      if (sel) {
        out[i] = { ...msg, content: choiceToPrompt(sel) };
        return { messages: out, choice: sel };
      }
      break; // 只检查最近一条用户消息
    }
  }
  return { messages: out, choice: null };
}
