// /bench 路由：并发压测 HTTP 入口。
// - POST /bench/api/run：接收 {mode,prompt,concurrency,rounds,agentId?,jwt?,model?}，
//   以 SSE 实时回吐 slot-start/ttft/chunk/slot-done/round-done/report 事件。
//   编排：轮次串行，每轮内 concurrency 个探测并发（Promise.all）。
// - /bench、/bench/：静态托管 public/bench.html（与 handleDebugRoutes 一致）。
//
// 暂停/中止：前端关闭 SSE 连接 → req 'close' → AbortController.abort() → 探测流被取消，
// 已完成的槽位结果仍已回吐。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeRaw, probeE2E, type ProbeResult, type ProbeEvent } from "./probes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface BenchRequest {
  mode: "raw" | "e2e";
  prompt: string;
  concurrency: number;
  rounds: number;
  agentId?: string;
  jwt?: string;
  model?: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

// 单档位（本次请求）汇总：跨 rounds 的所有请求聚合。
function summarize(concurrency: number, results: ProbeResult[]) {
  const ok = results.filter((r) => r.ok && r.ttft !== null && r.tEnd !== null);
  const ttfts = ok.map((r) => r.ttft!).sort((a, b) => a - b);
  const tEnds = ok.map((r) => r.tEnd!).sort((a, b) => a - b);
  // 吐字速率（token/s），剔除 TTFT，更公平
  const rates = ok
    .map((r) => {
      const gen = (r.tEnd! - r.ttft!) / 1000;
      return gen > 0 && r.tokenCount ? r.tokenCount / gen : 0;
    })
    .filter((x) => x > 0);
  const stalls = ok.map((r) => r.stalls);
  const analyses = ok.map((r) => {
    const tl = aggregateTimeline(r.samples, r.tEnd);
    return analyzeTimeline(tl.timeline, tl.bucketMs);
  });
  const hits = analyses.filter((a) => a.hit);
  const tokenCounts = ok.map((r) => r.tokenCount ?? 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  return {
    concurrency,
    total: results.length,
    ok: ok.length,
    failed: results.length - ok.length,
    avgTtft: Math.round(avg(ttfts)),
    p50Ttft: percentile(ttfts, 0.5),
    p95Ttft: percentile(ttfts, 0.95),
    avgTotalMs: Math.round(avg(tEnds)),
    avgTokensPerSec: +avg(rates).toFixed(1),
    totalTokens: sum(tokenCounts),
    avgStalls: +avg(stalls).toFixed(2),
    // 吐字间隔（仅吐字期间，不含 TTFT）
    chunkGapP50: ok.length ? Math.round(percentile(ok.flatMap((r) => r.chunks).sort((a, b) => a - b), 0.5)) : 0,
    chunkGapP95: ok.length ? Math.round(percentile(ok.flatMap((r) => r.chunks).sort((a, b) => a - b), 0.95)) : 0,
    // 偶发卡顿（长回复中途突然变慢一段）：撞中请求数 / 最长低速带时长 / 带内最低速率
    stallHits: hits.length,
    stallMaxSpanMs: hits.length ? Math.max(...hits.map((a) => a.maxSpanMs)) : 0,
    stallMinRate: hits.length ? Math.min(...hits.map((a) => a.minRate)) : 0,
  };
}

// 把每个 chunk 的时序样本聚合成"每桶 chars/s"速率序列，用于画吐字速率时间轴。
// 桶宽自适应：约 1 桶/秒，上限 120 桶，保证长短回复都可视化。
function aggregateTimeline(samples: { t: number; c: number }[], tEndMs: number | null): { timeline: number[]; bucketMs: number } {
  if (!samples.length) return { timeline: [], bucketMs: 0 };
  const last = samples[samples.length - 1].t;
  const span = Math.max(last, tEndMs ?? last, 1);
  const buckets = Math.min(120, Math.max(1, Math.round(span / 1000)));
  const bucketMs = span / buckets;
  const arr = new Array(buckets).fill(0);
  for (const s of samples) {
    let idx = Math.floor(s.t / bucketMs);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    arr[idx] += s.c;
  }
  const perSec = bucketMs > 0 ? 1000 / bucketMs : 1;
  return { timeline: arr.map((n) => +(n * perSec).toFixed(1)), bucketMs: Math.round(bucketMs) };
}

interface StallBand { startMs: number; spanMs: number; rate: number; }
interface TimelineAnalysis {
  hit: boolean;         // 是否出现卡顿带（连续 ≥2 桶低于中位 30%）
  bands: StallBand[];
  maxSpanMs: number;
  minRate: number;
  median: number;
}
// 分析速率时间轴，找出"突然变慢一段"的低速带。阈值=中位速率 30%。
function analyzeTimeline(timeline: number[], bucketMs: number): TimelineAnalysis {
  const ret: TimelineAnalysis = { hit: false, bands: [], maxSpanMs: 0, minRate: 0, median: 0 };
  if (timeline.length < 4) return ret;
  const sorted = [...timeline].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  ret.median = +median.toFixed(1);
  if (median === 0) return ret;
  const thr = median * 0.3;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i <= timeline.length; i++) {
    const low = i < timeline.length && timeline[i] < thr;
    if (low) {
      if (runStart < 0) runStart = i;
      runLen++;
    } else {
      if (runStart >= 0 && runLen >= 2) {
        let rmin = Infinity;
        for (let j = runStart; j < runStart + runLen; j++) rmin = Math.min(rmin, timeline[j]);
        ret.bands.push({ startMs: runStart * bucketMs, spanMs: runLen * bucketMs, rate: +rmin.toFixed(1) });
        ret.maxSpanMs = Math.max(ret.maxSpanMs, runLen * bucketMs);
      }
      runStart = -1;
      runLen = 0;
    }
  }
  ret.hit = ret.bands.length > 0;
  ret.minRate = ret.bands.length ? Math.min(...ret.bands.map((b) => b.rate)) : 0;
  return ret;
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // 解析 body
  let payload: BenchRequest;
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch {
    sendJson(res, 400, { error: "无效 JSON body" });
    return;
  }
  const mode = payload.mode === "e2e" ? "e2e" : "raw";
  const concurrency = Math.max(1, Math.min(64, Number(payload.concurrency) || 1));
  const rounds = Math.max(1, Math.min(100, Number(payload.rounds) || 1));
  const prompt = (payload.prompt || "").trim();
  if (!prompt) { sendJson(res, 400, { error: "prompt 不能为空" }); return; }
  if (mode === "e2e" && !payload.agentId) { sendJson(res, 400, { error: "e2e 模式需要 agentId" }); return; }

  // e2e 回连本服务的 origin：从 Host 头还原
  const host = req.headers.host || "127.0.0.1:9876";
  const baseOrigin = `http://${host}`;

  // SSE 头
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (obj: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on("close", onClose);

  const allResults: ProbeResult[] = [];
  const tWhole = Date.now();
  emit({ type: "start", mode, concurrency, rounds, prompt });

  try {
    for (let r = 0; r < rounds; r++) {
      if (ac.signal.aborted) break;
      const roundT0 = Date.now();
      emit({ type: "round-start", round: r, concurrency });

      const results = await Promise.all(
        Array.from({ length: concurrency }, async (_, slot) => {
          const reqId = `r${r}s${slot}`;
          emit({ type: "slot-start", reqId, round: r, slot });
          const onEvent = (e: ProbeEvent) => {
            if (e.type === "ttft") emit({ type: "ttft", reqId, ms: e.ms });
            else if (e.type === "chunk") emit({ type: "chunk", reqId, chars: e.chars, gap: e.ms });
            else if (e.type === "error") emit({ type: "slot-error", reqId, message: e.message });
          };
          const probe =
            mode === "raw"
              ? probeRaw({ prompt, model: payload.model, signal: ac.signal, onEvent })
              : probeE2E({ baseOrigin, agentId: payload.agentId!, prompt, jwt: payload.jwt, signal: ac.signal, onEvent });
          const result = await probe;
          const { t0, ttft, tEnd, charCount, tokenCount, stalls, text } = result;
          const tl = aggregateTimeline(result.samples, tEnd);
          const an = analyzeTimeline(tl.timeline, tl.bucketMs);
          emit({
            type: "slot-done",
            reqId,
            round: r,
            slot,
            ok: result.ok,
            t0,
            ttft,
            tEnd,
            charCount,
            tokenCount,
            stalls,
            error: result.error,
            preview: text.slice(0, 120),
            timeline: tl.timeline,
            bucketMs: tl.bucketMs,
            stallHit: an.hit,
            stallBands: an.bands,
            stallMaxSpanMs: an.maxSpanMs,
          });
          return result;
        })
      );

      allResults.push(...results);
      const roundWall = Date.now() - roundT0;
      const totalTokens = results.reduce((a, b) => a + (b.tokenCount ?? 0), 0);
      emit({
        type: "round-done",
        round: r,
        wallMs: roundWall,
        throughput: +(roundWall > 0 ? (totalTokens / (roundWall / 1000)) : 0).toFixed(1),
        summary: summarize(concurrency, results),
      });
    }

    emit({
      type: "report",
      mode,
      concurrency,
      rounds,
      wallMs: Date.now() - tWhole,
      summary: summarize(concurrency, allResults),
      // 完整明细供前端导出
      details: allResults.map((r, i) => ({
        i,
        ok: r.ok,
        t0: r.t0,
        ttft: r.ttft,
        tEnd: r.tEnd,
        charCount: r.charCount,
        tokenCount: r.tokenCount,
        stalls: r.stalls,
        error: r.error,
      })),
    });
  } catch (err) {
    emit({ type: "fatal", message: (err as Error).message });
  } finally {
    req.off("close", onClose);
    res.end();
  }
}

export async function handleBenchRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  _query: URLSearchParams
): Promise<boolean> {
  if (pathname === "/bench/api/run" && req.method === "POST") {
    await handleRun(req, res);
    return true;
  }

  // 静态托管：/bench → bench.html
  if (pathname === "/bench" || pathname === "/bench/" || pathname.startsWith("/bench/")) {
    const rel = pathname === "/bench" || pathname === "/bench/" ? "bench.html" : pathname.slice("/bench/".length);
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: "Forbidden" });
      return true;
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Not found", path: rel });
    }
    return true;
  }

  return false;
}
