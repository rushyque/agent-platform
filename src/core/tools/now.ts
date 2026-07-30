import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";

// now —— 权威时间源（只读）。模型对时间估计易错（"几天前"/"上个月"常算错），
// 涉及时间相关判断时调用本工具取权威值。
// 项目可选提供 context.formatTime(ctx) 返回业务周期（如"第3班次"/"2026-W30"）。
export const nowTool: ToolDefinition = {
  name: "now",
  description:
    "获取当前权威时间（ISO 字符串 + 时间戳，可能含业务周期）。需要做时间相关判断时调用。",
  parameters: z.object({}),
  readonly: true,
  execute: async (_args: any, context: AgentContext) => {
    const formatTime = (context as any).formatTime as
      | ((ctx: any) => string | undefined)
      | undefined;
    const iso = new Date().toISOString();
    const business = formatTime ? formatTime(context) : undefined;
    return { ok: true, iso, ts: Date.now(), ...(business ? { business } : {}) };
  },
};
