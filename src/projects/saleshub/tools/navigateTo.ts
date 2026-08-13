import { z } from "zod";
import type { ToolDefinition, AgentContext } from "../../../types/agent-config.js";

// SalesHub 内置路由白名单。模型只能在列表里选一个，不能瞎编路径。
// 路由守卫沿用前端 vue-router 的角色限制（如 /recon 仅销售员），跳转失败由守卫自行拦回。
const ROUTES = [
  "/dashboard",
  "/order-records",
  "/recon",
  "/remittance/fill",
  "/remittance/review",
  "/customers/list",
  "/inquiries",
  "/visit-plans",
  "/sales-groups",
  "/analytics/overview",
  "/analytics/workshop",
  "/document-scan",
  "/settings",
] as const;

const ROUTE_LABELS: Record<string, string> = {
  "/dashboard": "工作台",
  "/order-records": "定单记录",
  "/recon": "冲红/预付对账",
  "/remittance/fill": "汇款录入",
  "/remittance/review": "汇款审核",
  "/customers/list": "客户列表",
  "/inquiries": "询盘",
  "/visit-plans": "拜访计划",
  "/sales-groups": "销售分组",
  "/analytics/overview": "数据分析概览",
  "/analytics/workshop": "数据分析工作台",
  "/document-scan": "文档扫描",
  "/settings": "系统设置",
};

// 跳转由前端在 TOOL_CALL_RESULT / 调用参数里解析 ui:{type:'open_link'} 后执行 router.push。
export const navigateToTool: ToolDefinition = {
  name: "navigate_to",
  description:
    "打开/跳转到 SalesHub 的某个内置页面（路由跳转）。用户明确要求'打开/跳到/导航到/去'某页面时调用；route 只能从内置列表选，label 可给中文页面名。",
  parameters: z.object({
    route: z.enum(ROUTES).describe("目标内置路由，只能从白名单里选"),
    label: z
      .string()
      .optional()
      .describe("中文页面名（不填则用内置对应名称）"),
  }),
  readonly: true,
  execute: async (args: any, _context: AgentContext) => {
    const route = String(args.route || "");
    return {
      ok: true,
      ui: {
        type: "open_link",
        url: route,
        label: (args.label as string) || ROUTE_LABELS[route] || route,
        mode: "navigate",
      },
      hint: "Open " + ((args.label as string) || ROUTE_LABELS[route] || route),
    };
  },
};
