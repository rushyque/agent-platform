import type { Message } from "@ag-ui/core";
import type { AgentContext } from "../../types/agent-config.js";

// SalesHub 意图分类 —— 只分两类，够用、可预测：
//  - "query"   需要真实业务数据/事实，必须走工具（订单/客户/统计等），平台用低温保真。
//  - "general" 开放性问题（起草文案、解释、给建议、头脑风暴、闲聊、说明），
//              不强制工具，平台按需提温释放表达。
// 判定依据：最后一条用户消息出现"数据诉求"关键词 → query；否则 general。
// 与 AgentConfig.intentTemperature 配合（query 低温、general 提温）。
export function classifySalesIntent(params: {
  messages: Message[];
  context: AgentContext;
}): string {
  const msgs = params.messages;
  const last = Array.isArray(msgs)
    ? [...msgs].reverse().find((m) => m?.role === "user")
    : undefined;
  const text = last && typeof last.content === "string" ? last.content : "";
  if (!text) return "query";

  // 数据诉求关键词：命中即走查询类（低温度，工具保真）。
  const queryHints = [
    "订单", "工单", "客户", "金额", "收款", "余额", "统计",
    "多少", "几个", "几单", "几个客户", "总额", "已收", "未收",
    "列表", "明细", "详情", "状态", "日期", "发货", "下单",
    "本周", "本月", "上周", "上月", "今年", "占比", "分布",
    "数据", "查询", "查一下", "历史", "记录", "发票",
  ];
  const hit = queryHints.some((k) => text.includes(k));
  return hit ? "query" : "general";
}
