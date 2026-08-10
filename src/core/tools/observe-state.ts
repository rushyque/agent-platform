import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../types/agent-config.js";

// observe_state —— 查看系统当前运行态快照（只读）。
// 与只读数据查询原语（list_tables / describe_table / run_sql）的区别：
// 本工具看的是 in-memory 运行态（状态机/会话/任务进度），不是数据库里的业务数据。
// 模型只学一个名字"看现状"，不用懂各项目状态结构。
//
// 数据来源：项目在 resolveContext 返回 context.getState(ctx, focus?)。
// 返回的 state 由项目定义（自由结构）；大体量由 toAISDKTools 自动外置为 artifact。
export const observeStateTool: ToolDefinition = {
  name: "observe_state",
  description:
    "查看系统当前运行状态快照（任务进度/会话状态/运行态，非数据库数据）。" +
    "用于了解「现在什么情况」。只读。查数据库业务数据请用 run_sql，不要用本工具。",
  parameters: z.object({
    focus: z
      .string()
      .optional()
      .describe("可选：聚焦某块状态，如 'orders'/'workshop'。不传则返回整体概览"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    // 优先 summarizeState（精简概览，返回文本）；缺省回退 getState（完整 state，大对象由 toAISDKTools 外置）。
    const summarizeState = (context as any).summarizeState as
      | ((ctx: any, focus?: string) => string | Promise<string>)
      | undefined;
    if (summarizeState) {
      const summary = await Promise.resolve(summarizeState(context, args.focus));
      return { ok: true, summary };
    }
    const getState = (context as any).getState as
      | ((ctx: any, focus?: string) => any | Promise<any>)
      | undefined;
    if (!getState) {
      return {
        ok: false,
        error: "未配置状态钩子：需在 resolveContext 返回 context.summarizeState 或 context.getState。",
      };
    }
    const state = await Promise.resolve(getState(context, args.focus));
    return { ok: true, state };
  },
};
