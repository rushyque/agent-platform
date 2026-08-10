import { z } from "zod";
import type { ToolDefinition } from "../../types/agent-config.js";
import { getCtx } from "../../observe/als.js";

// set_note / get_note —— 本线程便签（工作记忆）。
// 治 DeepSeek 反复重查：模型把"已确认事实"记下来，后续 get_note 取，不重查原工具。
// 便签是对抗压缩丢失的锚点 → get_note 标 readonly 不折叠；set_note 结果很小，折叠无妨。
// 作用域：本线程（threadId）。中台无线程结束信号，故按 LRU 上限淘汰最久未访问的线程，
// 避免长生命周期进程下 threadId 无限累积（与 artifact-store 的 evict 同一思路）。

interface ThreadBucket {
  notes: Map<string, string>;
  ts: number; // 最后访问时间，LRU 依据
}

const threadNotes = new Map<string, ThreadBucket>();
const MAX_THREADS = 200; // 内存上限，超限淘汰最久未访问的线程（与 connections 环形上限一致）

function evictThreads(): void {
  while (threadNotes.size > MAX_THREADS) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of threadNotes) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) threadNotes.delete(oldestKey);
    else break;
  }
}

// 取（必要时创建）某线程的便签 Map，并刷新该线程的 LRU 访问时间。
function notesFor(threadId: string): Map<string, string> {
  let bucket = threadNotes.get(threadId);
  if (!bucket) {
    bucket = { notes: new Map(), ts: Date.now() };
    threadNotes.set(threadId, bucket);
    evictThreads();
  } else {
    bucket.ts = Date.now(); // 读/写都算访问，常被触及的线程更不易被淘汰
  }
  return bucket.notes;
}

function currentThread(): string | null {
  return getCtx()?.threadId ?? null;
}

export const setNoteTool: ToolDefinition = {
  name: "set_note",
  description:
    "记下一条已确认的事实/中间结论到便签（本线程内）。用于避免重复查询同一信息——" +
    "查到确定数据后存进来，后续用 get_note 取回，不重查。",
  parameters: z.object({
    key: z.string().describe("便签键，语义化，如 '客户A总销售额' / '库存P20数量'"),
    content: z.string().describe("便签内容，已确认的事实/结论"),
  }),
  execute: async (args: any) => {
    const tid = currentThread();
    if (!tid) return { ok: false, error: "无法确定会话上下文" };
    notesFor(tid).set(args.key, args.content);
    return { ok: true, key: args.key };
  },
};

export const getNoteTool: ToolDefinition = {
  name: "get_note",
  description:
    "读取本线程便签。key 省略则列出全部便签的 key 概览。用于取回之前记下的确认事实，避免重查。",
  parameters: z.object({
    key: z.string().optional().describe("要取的便签 key；省略则列出全部"),
  }),
  readonly: true,
  execute: async (args: any) => {
    const tid = currentThread();
    if (!tid) return { ok: false, error: "无法确定会话上下文" };
    // 读取也经 notesFor，刷新 LRU ts（常被读取的线程更不易被淘汰）
    const notes = notesFor(tid);
    if (args.key) {
      const content = notes.get(args.key);
      return content != null
        ? { ok: true, key: args.key, content }
        : { ok: false, error: `无此便签: ${args.key}` };
    }
    const all = Array.from(notes.entries()).map(([k, v]) => ({ key: k, content: v }));
    return { ok: true, count: all.length, notes: all };
  },
};
