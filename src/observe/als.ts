import { AsyncLocalStorage } from "node:async_hooks";

// 观察层运行上下文。run 开始时在入口包一层 runWithCtx，下游所有日志/工具/hook
// 通过 getCtx() 自动拿到归属。注意：streamText 立即返回、流由 CopilotKit 惰性迭代，
// 可能脱离 als 续体 → onStepFinish/onFinish 内 getCtx() 不保证有效。因此：
//   - ALS 仅用于"日志归属"（深路径如工具 execute），失效时降级为无 context。
//   - runs 通道生产者一律显式传 context，不依赖 ALS。
export interface ObservabilityCtx {
  runId: string;
  threadId: string;
  agentId: string;
  userId?: string;
  /** 一次外部触发的全链路 id（规范 §7），来自 HTTP 入口 traceId=reqId */
  traceId?: string;
  route: "hermes" | "dag";
}

const als = new AsyncLocalStorage<ObservabilityCtx>();

export function runWithCtx<T>(ctx: ObservabilityCtx, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getCtx(): ObservabilityCtx | undefined {
  try {
    return als.getStore();
  } catch {
    return undefined;
  }
}
