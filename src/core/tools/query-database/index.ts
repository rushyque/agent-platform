import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../../types/agent-config.js";
import { runNL2SQLAgent } from "./nl2sql-agent.js";
import type { DatabaseBackend } from "./backend.js";

// query_database —— NL→SQL 通用查询工具（只读）。
// 模型只传自然语言；工具内部：选表 → 生成 SQL → guardSQL → 执行 → 自纠 → trace。
// 数据来源：项目在 resolveContext 返回 context.database（DatabaseBackend 实例，
//   如 createMssqlBackend()），或由中台在 P5 据 AgentConfig.database 注入。
//
// 设计理念（见 .claude/plans/中台通用工具层.md）：
//   - 能力原语：能查任意库数据，不是某个业务的固定步骤。
//   - 结构化事实：返回 {rows, sql, explanation, trace}，不写自然语言总结。
//   - 只读：readonly=true，结果不进折叠候选；guardSQL 硬拦写操作。
export const queryDatabaseTool: ToolDefinition = {
  name: "query_database",
  description:
    "用自然语言查询数据库：自动选表→生成并执行只读 SQL→失败自纠→返回行数据+SQL+解释+trace。" +
    "用于查任意业务数据（订单/库存/客户/统计等）。只读，绝不修改数据；复杂统计也可用（自动 GROUP BY/聚合）。" +
    "已能用专用工具（如 observe_state 看运行态快照）查的，优先用专用工具，不要用本工具。",
  parameters: z.object({
    question: z
      .string()
      .describe("要查询的问题，自然语言。例：最近10笔销售订单 / 销售额最高的5个客户"),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("返回行数上限，默认 50"),
  }),
  readonly: true,
  execute: async (args: any, context: AgentContext) => {
    const backend = (context as any).database as DatabaseBackend | undefined;
    if (!backend) {
      return {
        ok: false,
        error:
          "未配置数据库后端：需在 resolveContext 返回 context.database（如 createMssqlBackend()），或在 AgentConfig.database 提供。",
      };
    }
    return runNL2SQLAgent({
      question: args.question,
      backend,
      limit: args.limit,
    });
  },
};
