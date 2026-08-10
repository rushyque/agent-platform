import { z } from "zod";
import type { ToolDefinition } from "../../types/agent-config.js";
import { getCtx } from "../../observe/als.js";
import { listArtifacts } from "../context/artifact-store.js";

// recall —— 回看本线程近期调用过的工具结果摘要（只读）。
// 治 DeepSeek 瞎编 getArtifact ref / 反复重查：给个官方回看通道，按工具名/作用域/最近N条搜历史。
// 与 getArtifact 互补：recall 按条件搜（返回 toolName/ref/summary/seq），getArtifact 按 ref 精取完整数据。
export const recallTool: ToolDefinition = {
  name: "recall",
  description:
    "回看本线程近期调用过的工具结果摘要。需要回忆「之前查到什么」但不想重查时用。" +
    "返回 toolName / ref / summary / seq。需要某条结果完整数据时，用返回的 ref 调 getArtifact 取回。" +
    "（不要用它替代 run_sql / list_tables / describe_table 去查新数据——它只回看历史结果。）" +
    "since:this_run=仅本次 run;last_step=最近一次;thread(默认)=本线程全部。",
  parameters: z.object({
    toolName: z
      .string()
      .optional()
      .describe("只看某个工具的结果（模糊匹配）；省略则全部"),
    since: z
      .enum(["thread", "this_run", "last_step"])
      .optional()
      .describe("作用域：thread=本线程全部(默认)；this_run=仅本次 run；last_step=最近一次"),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("返回条数上限，默认 10（last_step 下忽略，固定返回最近 1 条）"),
  }),
  readonly: true,
  execute: async (args: any) => {
    const ctx = getCtx();
    const tid = ctx?.threadId;
    if (!tid) return { ok: false, error: "无法确定会话上下文" };
    const since = (args.since as "thread" | "this_run" | "last_step") ?? "thread";

    // last_step 只取最近 1 条（忽略 limit）；this_run 用当前 runId 过滤；thread 取全部。
    const effectiveLimit = since === "last_step" ? 1 : args.limit ?? 10;
    const list = await listArtifacts({
      threadId: tid,
      runId: since === "this_run" ? ctx?.runId : undefined,
      limit: effectiveLimit,
    });

    // listArtifacts 按 createdAt 降序（最新在前）。seq = 返回顺序序号（最新为 1）。
    // 注：seq 是工具调用序，非模型步号——artifact 未存 stepNumber，真步号需另改 schema，见计划说明。
    let items = list.map((a, idx) => ({
      toolName: a.toolName,
      ref: a.ref,
      summary: a.summary,
      at: a.createdAt,
      seq: idx + 1,
    }));

    if (args.toolName) {
      const q = String(args.toolName).toLowerCase();
      items = items.filter((i) => i.toolName.toLowerCase().includes(q));
    }
    return { ok: true, since, count: items.length, items };
  },
};
