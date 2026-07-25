// 并发压测探测层：两种链路统一返回 ProbeResult。
// - 纯模型直连（probeRaw）：原生 fetch 调 DeepSeek /chat/completions（stream:true），绕过 CopilotKit/中间件，
//   定位"模型本身"在并发下的能力。
// - 经中台端到端（probeE2E）：fetch 本服务 /agent/{agentId}/run（AG-UI SSE），测真实用户路径。
//
// 时序口径统一：
//   t0    发起请求
//   ttft  首个用户可见 token 到达（raw=首个 delta.content；e2e=首个 TEXT_MESSAGE_CONTENT，推理事件不算）
//   tEnd  流结束
//   chunks[] 相邻 chunk 时间戳数组（用于算吐字间隔 P50/P95 + stall 次数）
//
// stall 阈值 500ms 与 core/llm.ts:33 中台运行时日志一致，便于横向对照。

import { randomUUID } from "node:crypto";
import { settings } from "../config/settings.js";

export interface ProbeEvent {
  type: "ttft" | "chunk" | "done" | "error";
  ms?: number; // 对 ttft: t0→首字；对 chunk: 自上一 chunk 间隔；对 done: t0→tEnd 总时长
  chars?: number; // chunk 本次新增字符数（用于前端进度条累加）
  message?: string; // error 时
}

export interface ProbeResult {
  ok: boolean;
  mode: "raw" | "e2e";
  t0: number;
  ttft: number | null; // ms，null=未出首字就失败
  tEnd: number | null; // ms，null=流未正常结束
  chunks: number[]; // 相邻 chunk 间隔 ms（不含 t0→ttft 这一段，仅吐字期间）
  stalls: number; // 间隔 > 500ms 的次数
  samples: { t: number; c: number }[]; // 每个 content chunk 的 {相对 t0 的 ms, 本次字符数}，用于吐字速率时间轴
  text: string; // 累计可见文本
  tokenCount: number | null; // raw 优先取 usage.completion_tokens；e2e/缺失则按 chunk 段数估
  charCount: number;
  error?: string;
}

const STALL_MS = 500;

function newResult(mode: "raw" | "e2e"): ProbeResult {
  return { ok: false, mode, t0: 0, ttft: null, tEnd: null, chunks: [], stalls: 0, samples: [], text: "", tokenCount: null, charCount: 0 };
}

// 把 SSE 文本流切成逐条 data JSON 的异步迭代器。
// 兼容两种格式：① 纯 `data: {...}`；② AG-UI 风格 `event: X\ndata: {...}`。只关心 data 行。
async function* sseLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) { reader.cancel().catch(() => {}); return; }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔；同一事件的 data 行可能多行，合并
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""));
        const data = dataLines.join("\n").trim();
        if (data && data !== "[DONE]") yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ===== 纯模型直连 =====
export async function probeRaw(opts: {
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  onEvent?: (e: ProbeEvent) => void;
}): Promise<ProbeResult> {
  const { prompt, model, signal, onEvent } = opts;
  const result = newResult("raw");
  const t0 = Date.now();
  result.t0 = t0;
  let lastChunkTs = 0;

  const url = `${settings.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: model || settings.DEEPSEEK_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  };

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    result.error = `请求失败: ${(err as Error).message}`;
    onEvent?.({ type: "error", message: result.error });
    return result;
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    result.error = `HTTP ${resp.status} ${resp.statusText} ${text.slice(0, 200)}`;
    onEvent?.({ type: "error", message: result.error });
    return result;
  }

  try {
    for await (const data of sseLines(resp.body, signal)) {
      let obj: any;
      try { obj = JSON.parse(data); } catch { continue; }
      const delta = obj?.choices?.[0]?.delta;
      const content: string | undefined = delta?.content;
      const now = Date.now();

      // TTFT：首个非空 content
      if (result.ttft === null && content) {
        result.ttft = now - t0;
        onEvent?.({ type: "ttft", ms: result.ttft });
      }

      // chunk 间隔统计（首字之后才开始记，避免把 TTFT 算进吐字间隔）
      if (result.ttft !== null) {
        if (lastChunkTs > 0) {
          const gap = now - lastChunkTs;
          result.chunks.push(gap);
          if (gap > STALL_MS) result.stalls++;
        }
        lastChunkTs = now;
      }

      if (content) {
        result.text += content;
        result.charCount += content.length;
        result.samples.push({ t: now - t0, c: content.length });
        onEvent?.({ type: "chunk", chars: content.length, ms: lastChunkTs > 0 ? now - lastChunkTs : 0 });
      }

      // finish chunk 的 usage
      if (obj?.usage?.completion_tokens) {
        result.tokenCount = obj.usage.completion_tokens;
      }
      if (obj?.choices?.[0]?.finish_reason) {
        // 流结束
      }
    }
    result.tEnd = Date.now() - t0;
    if (result.tokenCount === null && result.ttft !== null) {
      // 无 usage：按可见 chunk 段数估算（粗略，仅当无 usage 时）
      result.tokenCount = result.chunks.length + 1;
    }
    result.ok = result.ttft !== null;
    onEvent?.({ type: "done", ms: result.tEnd });
    return result;
  } catch (err) {
    if (signal?.aborted) {
      result.tEnd = Date.now() - t0;
      result.ok = result.ttft !== null;
      onEvent?.({ type: "done", ms: result.tEnd });
      return result;
    }
    result.error = `流读取失败: ${(err as Error).message}`;
    onEvent?.({ type: "error", message: result.error });
    return result;
  }
}

// ===== 经中台端到端（AG-UI）=====
export async function probeE2E(opts: {
  baseOrigin: string; // 如 http://127.0.0.1:9876
  agentId: string;
  prompt: string;
  jwt?: string;
  signal?: AbortSignal;
  onEvent?: (e: ProbeEvent) => void;
}): Promise<ProbeResult> {
  const { baseOrigin, agentId, prompt, jwt, signal, onEvent } = opts;
  const result = newResult("e2e");
  const t0 = Date.now();
  result.t0 = t0;
  let lastChunkTs = 0;

  const url = `${baseOrigin.replace(/\/$/, "")}/agent/${encodeURIComponent(agentId)}/run`;
  const id = randomUUID();
  // RunAgentInputSchema（@ag-ui/client）要求 tools/context 为数组；threadId/runId 必填。
  const body = {
    threadId: `bench-${id}`,
    runId: `bench-${id}`,
    messageId: `bench-msg-${id}`,
    messages: [{ id: `bench-msg-${id}`, role: "user", content: prompt }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (err) {
    result.error = `请求失败: ${(err as Error).message}`;
    onEvent?.({ type: "error", message: result.error });
    return result;
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    result.error = `HTTP ${resp.status} ${resp.statusText} ${text.slice(0, 200)}`;
    onEvent?.({ type: "error", message: result.error });
    return result;
  }

  try {
    for await (const data of sseLines(resp.body, signal)) {
      let obj: any;
      try { obj = JSON.parse(data); } catch { continue; }
      const type: string = obj?.type ?? obj?.event ?? "";
      const now = Date.now();

      // 用户可见首字：TEXT_MESSAGE_CONTENT（推理 REASONING_* 不算）
      const isTextContent =
        type === "TEXT_MESSAGE_CONTENT" ||
        type === "text-delta" ||
        type === "TEXT_MESSAGE_DELTA";
      if (result.ttft === null && isTextContent) {
        result.ttft = now - t0;
        onEvent?.({ type: "ttft", ms: result.ttft });
      }

      if (result.ttft !== null) {
        if (lastChunkTs > 0) {
          const gap = now - lastChunkTs;
          result.chunks.push(gap);
          if (gap > STALL_MS) result.stalls++;
        }
        lastChunkTs = now;
      }

      // 文本内容字段兼容（AG-UI: delta；text-delta 风格: delta）
      const piece: string | undefined = obj?.delta ?? obj?.content ?? obj?.text;
      if (isTextContent && typeof piece === "string") {
        result.text += piece;
        result.charCount += piece.length;
        result.samples.push({ t: now - t0, c: piece.length });
        onEvent?.({ type: "chunk", chars: piece.length, ms: lastChunkTs > 0 ? now - lastChunkTs : 0 });
      }

      if (type === "RUN_FINISHED" || type === "RUN_ERROR") {
        if (type === "RUN_ERROR") result.error = obj?.message || obj?.error || "RUN_ERROR";
        break;
      }
    }
    result.tEnd = Date.now() - t0;
    if (result.tokenCount === null && result.ttft !== null) {
      result.tokenCount = result.chunks.length + 1;
    }
    result.ok = result.ttft !== null && result.error === undefined;
    onEvent?.({ type: "done", ms: result.tEnd });
    return result;
  } catch (err) {
    if (signal?.aborted) {
      result.tEnd = Date.now() - t0;
      result.ok = result.ttft !== null;
      onEvent?.({ type: "done", ms: result.tEnd });
      return result;
    }
    result.error = `流读取失败: ${(err as Error).message}`;
    onEvent?.({ type: "error", message: result.error });
    return result;
  }
}
