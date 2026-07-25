import type { BaseEvent } from "@ag-ui/core";

// AG-UI 事件存储 —— 纯内存（append-only）。connect() 重放、/debug 回放都读这里。重启清空。
// 曾用 MSSQL agent_events 表；中台去 DB 后改内存，避免凭据/超时/降级问题。

export interface EventRow {
  threadId: string;
  runId: string;
  agentId: string;
}

const eventsByThread = new Map<string, BaseEvent[]>();

export async function appendEvents(meta: EventRow, events: BaseEvent[]): Promise<void> {
  if (!events.length) return;
  const list = eventsByThread.get(meta.threadId);
  if (list) list.push(...events);
  else eventsByThread.set(meta.threadId, [...events]);
}

export async function getEvents(threadId: string): Promise<BaseEvent[]> {
  return eventsByThread.get(threadId) ?? [];
}

export async function clearEvents(threadId: string): Promise<void> {
  eventsByThread.delete(threadId);
}
