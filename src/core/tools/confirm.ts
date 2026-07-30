import { z } from "zod";
import type { ToolDefinition } from "../../types/agent-config.js";

// confirm —— 人确认（异步简版，写操作前的通用兜底）。
// 模型调本工具 → 返回 pending 信封 → 模型把动作转述给用户 → 用户下一轮确认/取消 → 模型续跑。
// 不阻塞、不需要前端配合（同步版弹框待前端 SDK）。
// 不标 readonly：它的结果（pending 状态）可折叠，不影响流程。
export const confirmTool: ToolDefinition = {
  name: "confirm",
  description:
    "请求用户确认一个可能有副作用/不可逆的动作。执行写操作或高风险动作前【必须】先调用。" +
    "返回 pending 后，你需把动作转述给用户，等用户回复确认/取消后再决定是否真正执行。",
  parameters: z.object({
    action: z.string().describe("要确认的动作，一句话，如 '删除订单 SO-2026-0001'"),
    summary: z
      .string()
      .describe("为什么做 / 影响范围，给用户判断依据"),
    risk: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("风险等级，默认 medium"),
  }),
  execute: async (args: any) => {
    const risk = args.risk ?? "medium";
    return {
      ok: false,
      pending: true,
      action: args.action,
      risk,
      message: `请在下方确认是否${args.action}（${args.summary}）`,
      instruction:
        "等待用户回复「确认/是」后再执行该动作；回复「取消/否」则不执行并告知用户。",
    };
  },
};
