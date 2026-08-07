// 跟随测试（follow suite）：验证"思考体 + 最终回复"是否持续使用用户的语言。
//
// 设计原则：
//  - 尽量用复杂问题（分析、对比、因果推理），不用"只回答X / 用中文思考 / 别切英文"这类指令注入；
//  - 以多轮对话为单位：同一语言下连续追问，逐轮检查思考体与回复是否正确覆盖该语言；
//  - 分别统计"思考语言覆盖"与"回复语言覆盖"，能定位是"想了对但没说对"还是中途偏到别的语言。
//
// 语言依赖脚本判定：zh→CJK，en/fr/de→西文，fa→阿拉伯字母（波斯）；用 no_script 专查"切中文"这类漂移。

import { randomUUID } from "node:crypto";
import { probeChat, probeE2E, type ChatMessage } from "./probes.js";

export type Script = "cjk" | "latin" | "arabic";

export interface FollowCheck {
  id: string;
  label: string;
  kind:
    | "contains"
    | "contains_any"
    | "not_contains"
    | "only_script"
    | "require_script"
    | "no_script"
    | "dominate_script"
    | "max_len";
  target?: string; // contains
  targets?: string[]; // contains_any / not_contains
  script?: Script; // only_script / require_script / no_script
  max?: number; // max_len
}

// 一轮用户提问：自然复杂问题 + 对思考体和回复各自的检查。
export interface FollowThreadTurn {
  prompt: string;
  reasoning: FollowCheck[];
  answer: FollowCheck[];
}

// 一段多轮对话（同一语言）——若干轮连续追问。
export interface FollowThread {
  id: string;
  lang: string;
  note: string;
  turns: FollowThreadTurn[];
  // 可选：对话前预置的历史（如"已完成一次工具调用"），把工具返回素材作为上下文塞进首轮。
  // 仅 raw 模式注入；作用是复刻"工具调用那几步思考容易偏英文"的场景。
  seed?: ChatMessage[];
}

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface SectionGrade {
  passed: number;
  total: number;
  results: CheckResult[];
}

export interface TurnResult {
  index: number; // 1-based 轮次
  ok: boolean;
  error?: string;
  reasoningText: string;
  answerText: string;
  reasoning: SectionGrade;
  answer: SectionGrade;
  pass: boolean;
}

export interface ThreadResult {
  id: string;
  lang: string;
  note: string;
  ok: boolean; // 每轮探测成功
  error?: string;
  turns: TurnResult[];
  reasoningPassed: number;
  reasoningTotal: number;
  answerPassed: number;
  answerTotal: number;
  pass: boolean; // 所有轮次思考体与回复全过
}

export interface FollowReport {
  mode: "raw" | "e2e";
  model: string;
  reasoningEffort: string;
  generatedAt: number;
  total: number; // 对话总数
  okCount: number;
  reasoningPassed: number;
  reasoningTotal: number;
  answerPassed: number;
  answerTotal: number;
  fullPass: number;
  threads: ThreadResult[];
}

interface ScriptStats { cjk: number; latin: number; arabic: number; }

function stat(text: string): ScriptStats {
  let cjk = 0;
  let latin = 0;
  let arabic = 0;
  for (const ch of String(text || "")) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
    else if (/[A-Za-z\u00C0-\u024F]/.test(ch)) latin++;
    else if (/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(ch)) arabic++;
  }
  return { cjk, latin, arabic };
}

function countScript(s: ScriptStats, script: Script): number {
  return script === "cjk" ? s.cjk : script === "latin" ? s.latin : s.arabic;
}

const SCRIPT_LABEL: Record<Script, string> = {
  cjk: "CJK(中/日/韩)",
  latin: "西文",
  arabic: "阿拉伯字母(阿/波斯)",
};

function norm(s: string): string {
  return String(s || "").toLowerCase().trim();
}

function has(text: string, target: string): boolean {
  return norm(text).includes(norm(target));
}

// 对一段文本跑一组检查。
export function runChecks(text: string, checks: FollowCheck[]): SectionGrade {
  const results: CheckResult[] = checks.map((c) => {
    const t = text || "";
    let pass = false;
    let detail = "";
    switch (c.kind) {
      case "contains":
        pass = has(t, c.target || "");
        detail = pass ? `包含「${c.target}」` : `缺少「${c.target}」`;
        break;
      case "contains_any": {
        const hit = (c.targets || []).find((x) => has(t, x));
        pass = !!hit;
        detail = hit ? `命中「${hit}」` : `未命中任何: ${(c.targets || []).join("/")}`;
        break;
      }
      case "not_contains": {
        const hit = (c.targets || []).find((x) => has(t, x));
        pass = !hit;
        detail = hit ? `出现禁用内容「${hit}」` : "未出现禁用内容";
        break;
      }
      case "only_script": {
        const s = stat(t);
        const others: Array<[Script, number]> = (
          ["cjk", "latin", "arabic"] as Script[]
        ).filter((x) => x !== c.script).map((x) => [x, countScript(s, x)]);
        const hit = others.find(([, n]) => n > 0);
        pass = !hit;
        detail = hit
          ? `含非${SCRIPT_LABEL[c.script!]}字符（${SCRIPT_LABEL[hit[0]]} ×${hit[1]}）`
          : `仅 ${SCRIPT_LABEL[c.script!]}`;
        break;
      }
      case "require_script": {
        const s = stat(t);
        const n = countScript(s, c.script!);
        pass = n > 0;
        detail = n > 0 ? `含 ${SCRIPT_LABEL[c.script!]} ${n} 个` : `缺少 ${SCRIPT_LABEL[c.script!]}`;
        break;
      }
      case "no_script": {
        const s = stat(t);
        const n = countScript(s, c.script!);
        pass = n === 0;
        detail = n === 0 ? `不含 ${SCRIPT_LABEL[c.script!]}` : `含 ${SCRIPT_LABEL[c.script!]} ${n} 个（疑似漂移）`;
        break;
      }
      case "dominate_script": {
        const s = stat(t);
        const self = countScript(s, c.script!);
        const other = (["cjk", "latin", "arabic"] as Script[])
          .filter((x) => x !== c.script)
          .reduce((a, x) => a + countScript(s, x), 0);
        pass = self > 0 && self > other;
        detail = pass
          ? `以 ${SCRIPT_LABEL[c.script!]} 主导（${self} > ${other}）`
          : `非 ${SCRIPT_LABEL[c.script!]} 主导（${self} vs 其他 ${other}）`;
        break;
      }
      case "max_len":
        pass = t.length <= (c.max ?? Infinity);
        detail = `${t.length} 字符 ≤ ${c.max}`;
        break;
    }
    return { id: c.id, label: c.label, pass, detail };
  });
  return {
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  };
}

// ===== 多轮自然对话测试集 =====
// 全部为复杂问题，不注入"用X语思考 / 只回答 / 别切语言"等指令；语言由用户提问自然承载。
// 每轮对 reasoning 与 answer 独立判分，测"语言覆盖"是否在整段对话中稳定。
export const FOLLOW_THREADS: FollowThread[] = [
  {
    id: "zh-econ",
    lang: "zh",
    note: "中文·多轮宏观经济分析",
    turns: [
      {
        prompt: "请分析一下：为什么会出现通货膨胀？它对不同收入群体、储蓄者和企业的影响分别是什么？",
        reasoning: [
          { id: "r-zh", kind: "require_script", script: "cjk", label: "思考用中文" },
          { id: "r-only", kind: "only_script", script: "cjk", label: "思考不带西文" },
        ],
        answer: [
          { id: "a-zh", kind: "require_script", script: "cjk", label: "回复用中文" },
          { id: "a-only", kind: "only_script", script: "cjk", label: "回复不带西文" },
          { id: "a-topic", kind: "contains_any", targets: ["通胀", "价格", "货币", "购买力"], label: "紧扣通胀主题" },
        ],
      },
      {
        prompt: "接着上面聊：如果一个人把所有积蓄都存在银行、从不花销，在持续通胀的背景下，他的实际购买力长期会怎样变化？请结合货币购买力来解释。",
        reasoning: [
          { id: "r-zh", kind: "require_script", script: "cjk", label: "思考用中文" },
          { id: "r-only", kind: "only_script", script: "cjk", label: "思考不带西文" },
        ],
        answer: [
          { id: "a-zh", kind: "require_script", script: "cjk", label: "回复用中文" },
          { id: "a-only", kind: "only_script", script: "cjk", label: "回复不带西文" },
          { id: "a-topic", kind: "contains_any", targets: ["购买力", "贬值", "通胀", "利息"], label: "回答实际购买力" },
        ],
      },
      {
        prompt: "再往后推一步：政府在这种环境下通常会做什么？从货币政策的角度看，抑制通胀和刺激增长之间为什么很难两全？",
        reasoning: [
          { id: "r-zh", kind: "require_script", script: "cjk", label: "思考用中文" },
          { id: "r-only", kind: "only_script", script: "cjk", label: "思考不带西文" },
        ],
        answer: [
          { id: "a-zh", kind: "require_script", script: "cjk", label: "回复用中文" },
          { id: "a-only", kind: "only_script", script: "cjk", label: "回复不带西文" },
          { id: "a-topic", kind: "contains_any", targets: ["利率", "货币", "通胀", "央行", "政策"], label: "涉及货币政策" },
        ],
      },
    ],
  },
  {
    id: "en-history",
    lang: "en",
    note: "英文·多轮工业革命史论",
    turns: [
      {
        prompt: "Explain the principal causes of the Industrial Revolution and the most important long-term consequences it had for society.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用西文" },
          { id: "r-no-cn", kind: "no_script", script: "cjk", label: "思考不切中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用西文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["industrial", "steam", "factory", "urban", "machinery"], label: "紧扣工业革命" },
        ],
      },
      {
        prompt: "Building on that, compare how the effects you described played out differently in Britain versus Germany during the nineteenth century.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用西文" },
          { id: "r-no-cn", kind: "no_script", script: "cjk", label: "思考不切中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用西文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["britain", "germany", "coal", "rail", "steel"], label: "对比英德" },
        ],
      },
      {
        prompt: "Considering that comparison, why did European geopolitics become significantly more tense in the years before 1914? Make the link to industrialisation explicit.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用西文" },
          { id: "r-no-cn", kind: "no_script", script: "cjk", label: "思考不切中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用西文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["industry", "arm", "navy", "alliance", "war"], label: "联系一战前地缘" },
        ],
      },
    ],
  },
  {
    id: "fr-philosophy",
    lang: "fr",
    note: "法文·多轮政治哲学辨析",
    turns: [
      {
        prompt: "Explique précisément la différence entre la liberté négative et la liberté positive dans la pensée politique libérale.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用法文" },
          { id: "r-only", kind: "only_script", script: "latin", label: "思考不带中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用法文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["liberté", "négative", "positive", "interférence"], label: "辨析两种自由" },
        ],
      },
      {
        prompt: "En partant de cette distinction, comment analyser le débat actuel sur la régulation des réseaux sociaux ?",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用法文" },
          { id: "r-only", kind: "only_script", script: "latin", label: "思考不带中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用法文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["liberté", "régul", "réseaux", "censure"], label: "联系网络监管" },
        ],
      },
      {
        prompt: "Finalement, laquelle de ces deux conceptions te semble la mieux adaptée pour penser la liberté sur Internet ? Justifie ton choix.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用法文" },
          { id: "r-only", kind: "only_script", script: "latin", label: "思考不带中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用法文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["liberté", "positive", "négative", "choix"], label: "给出立场与理由" },
        ],
      },
    ],
  },
  {
    id: "fa-science",
    lang: "fa",
    note: "波斯语·多轮光学散射解释",
    turns: [
      {
        prompt: "چرا آسمان در روز آبی و در غروب قرمز دیده میشود؟ توضیح علمی دقیق بده.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "arabic", label: "思考用波斯语" },
          { id: "r-no-cn", kind: "no_script", script: "cjk", label: "思考不切中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "arabic", label: "回复用波斯语" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["پراکندگی", "نور", "طول", "موج"], label: "解释散射/波长" },
        ],
      },
      {
        prompt: "در همین زمینه، تفاوت پراکندگی ریلی و پراکندگی مای را توضیح بده و مثال بزن.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "arabic", label: "思考用波斯语" },
          { id: "r-no-cn", kind: "no_script", script: "cjk", label: "思考不切中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "arabic", label: "回复用波斯语" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["پراکندگی", "ریلی", "مای", "نور"], label: "对比两类散射" },
        ],
      },
      {
        prompt: "اگر جو زمین وجود نداشت، رنگ آسمان در طول روز چگونه بود؟ بر اساس توضیحات قبلی استدلال کن.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "arabic", label: "思考用波斯语" },
          { id: "r-no-cn", kind: "no_script", script: "cjk", label: "思考不切中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "arabic", label: "回复用波斯语" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["جو", "آسمان", "سیاه", "نور"], label: "论证无大气情形" },
        ],
      },
    ],
  },
  {
    id: "de-tech",
    lang: "de",
    note: "德文·多轮区块链技术讨论",
    turns: [
      {
        prompt: "Erkläre ausführlich, wie eine Blockchain funktioniert und warum sie als fälschungssicher gilt.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用德文" },
          { id: "r-only", kind: "only_script", script: "latin", label: "思考不带中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用德文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["blockchain", "hash", "kette", "dezentral"], label: "解释区块链原理" },
        ],
      },
      {
        prompt: "Welche praktischen Nachteile und Skalierungsprobleme treten bei Blockchains im Alltag auf?",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用德文" },
          { id: "r-only", kind: "only_script", script: "latin", label: "思考不带中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用德文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["skalier", "energie", "kosten", "transaktion"], label: "指出扩展性问题" },
        ],
      },
      {
        prompt: "Wie würde eine Designänderung aussehen, die Sicherheit und Geschwindigkeit besser in Einklang bringt? Begründe kurz.",
        reasoning: [
          { id: "r-script", kind: "require_script", script: "latin", label: "思考用德文" },
          { id: "r-only", kind: "only_script", script: "latin", label: "思考不带中文" },
        ],
        answer: [
          { id: "a-script", kind: "require_script", script: "latin", label: "回复用德文" },
          { id: "a-no-cn", kind: "no_script", script: "cjk", label: "回复不切中文" },
          { id: "a-topic", kind: "contains_any", targets: ["konsens", "sicherheit", "geschwind", "design"], label: "给出权衡与理由" },
        ],
      },
    ],
  },
  {
    id: "zh-tool",
    lang: "zh",
    note: "中文·工具调用后思考是否漂英文（复刻 craft-advisor 场景）",
    seed: [
      { role: "user", content: "帮我查一下‘坯底发白’这种注塑缺陷的处理思路。" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_manual_1",
            type: "function",
            function: { name: "search_manual", arguments: '{"topics":["坯底发白"]}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_manual_1",
        name: "search_manual",
        content: "[手册·坯底发白] 常见原因是模具温度偏低、排气不良。建议提高模温、检查排气、适当降低注射速率。",
      },
    ],
    turns: [
      {
        prompt: "根据刚才查到的结果，请继续用中文分析：为什么模具温度偏低会导致坯底发白？还有哪些工艺参数需要一起调整？",
        reasoning: [
          { id: "r-zh", kind: "require_script", script: "cjk", label: "思考含中文" },
          { id: "r-dom", kind: "dominate_script", script: "cjk", label: "思考以中文主导" },
        ],
        answer: [
          { id: "a-zh", kind: "require_script", script: "cjk", label: "回复用中文" },
          { id: "a-dom", kind: "dominate_script", script: "cjk", label: "回复以中文主导" },
          { id: "a-topic", kind: "contains_any", targets: ["模温", "排气", "发白", "参数"], label: "紧扣缺陷分析" },
        ],
      },
      {
        prompt: "再帮我把结论归纳成给现场师傅看的简短操作建议，请保持中文。",
        reasoning: [
          { id: "r-zh", kind: "require_script", script: "cjk", label: "思考含中文" },
          { id: "r-dom", kind: "dominate_script", script: "cjk", label: "思考以中文主导" },
        ],
        answer: [
          { id: "a-zh", kind: "require_script", script: "cjk", label: "回复用中文" },
          { id: "a-dom", kind: "dominate_script", script: "cjk", label: "回复以中文主导" },
        ],
      },
    ],
  },
];

export interface FollowRunOpts {
  mode: "raw" | "e2e";
  model?: string;
  reasoningEffort?: string;
  baseOrigin?: string;
  agentId?: string;
  jwt?: string;
  signal?: AbortSignal;
  threads?: FollowThread[];
  onTurn?: (threadId: string, index: number, turn: TurnResult) => void;
  onThread?: (thread: ThreadResult) => void;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export async function runFollowThreads(opts: FollowRunOpts): Promise<FollowReport> {
  const threads = opts.threads || FOLLOW_THREADS;
  const results: ThreadResult[] = [];
  const mode = opts.mode;

  for (const th of threads) {
    const threadKey = mode === "e2e" ? `bench-${randomUUID()}` : undefined;
    const rawMessages: ChatMessage[] = [...(th.seed || [])];
    const e2eMessages: Array<{ id: string; role: "user" | "assistant"; content: string }> = [];
    const turns: TurnResult[] = [];
    let threadOk = true;
    let threadError: string | undefined;

    for (let i = 0; i < th.turns.length; i++) {
      const turn = th.turns[i];
      let reasoningText = "";
      let answerText = "";
      let ok = false;
      let error: string | undefined;
      try {
        if (mode === "raw") {
          rawMessages.push({ role: "user", content: turn.prompt });
          const r = await probeChat({
            messages: rawMessages,
            model: opts.model,
            reasoningEffort: opts.reasoningEffort,
            signal: opts.signal,
          });
          ok = r.ok;
          error = r.error;
          reasoningText = r.reasoning;
          answerText = r.text;
          if (r.ok) rawMessages.push({ role: "assistant", content: r.text });
        } else {
          e2eMessages.push({ id: `msg-${i}`, role: "user", content: turn.prompt });
          const r = await probeE2E({
            baseOrigin: opts.baseOrigin || "http://127.0.0.1:9876",
            agentId: opts.agentId || "",
            prompt: turn.prompt,
            threadId: threadKey,
            messages: e2eMessages,
            jwt: opts.jwt,
            signal: opts.signal,
          });
          ok = r.ok;
          error = r.error;
          reasoningText = r.reasoning;
          answerText = r.text;
          if (r.ok) e2eMessages.push({ id: `msg-a${i}`, role: "assistant", content: r.text });
        }
      } catch (err) {
        error = (err as Error).message;
        ok = false;
      }
      const reasoning = runChecks(reasoningText, turn.reasoning);
      const answer = runChecks(answerText, turn.answer);
      const tr: TurnResult = {
        index: i + 1,
        ok,
        error,
        reasoningText,
        answerText,
        reasoning,
        answer,
        pass: ok && reasoning.passed === reasoning.total && answer.passed === answer.total,
      };
      if (!tr.ok) {
        threadOk = false;
        threadError = error;
      }
      turns.push(tr);
      opts.onTurn?.(th.id, i, tr);
      if (opts.signal?.aborted) break;
    }

    const reasoningPassed = sum(turns.map((t) => t.reasoning.passed));
    const reasoningTotal = sum(turns.map((t) => t.reasoning.total));
    const answerPassed = sum(turns.map((t) => t.answer.passed));
    const answerTotal = sum(turns.map((t) => t.answer.total));
    const tr: ThreadResult = {
      id: th.id,
      lang: th.lang,
      note: th.note,
      ok: threadOk,
      error: threadError,
      turns,
      reasoningPassed,
      reasoningTotal,
      answerPassed,
      answerTotal,
      pass: threadOk && reasoningPassed === reasoningTotal && answerPassed === answerTotal,
    };
    results.push(tr);
    opts.onThread?.(tr);
    if (opts.signal?.aborted) break;
  }

  const okThreads = results.filter((r) => r.ok);
  return {
    mode,
    model: opts.model || "",
    reasoningEffort: opts.reasoningEffort || "",
    generatedAt: Date.now(),
    total: results.length,
    okCount: okThreads.length,
    reasoningPassed: sum(okThreads.map((t) => t.reasoningPassed)),
    reasoningTotal: sum(okThreads.map((t) => t.reasoningTotal)),
    answerPassed: sum(okThreads.map((t) => t.answerPassed)),
    answerTotal: sum(okThreads.map((t) => t.answerTotal)),
    fullPass: results.filter((r) => r.pass).length,
    threads: results,
  };
}
