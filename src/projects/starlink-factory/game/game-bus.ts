// 游戏事件总线 —— 按 userId 分频道，引擎每次改状态后推送快照，
// 前端经 SSE /game/api/stream 订阅，据此渲染工厂动画。
import type { GameState } from "./types.js";

export interface GameBusEvent {
  kind: string; // 触发来源（工具名 / advance_shift 等）
  summary: string; // 人话摘要，前端走马灯/吐司用
  snapshot: GameState; // 全量快照（点状克隆），前端 diff 渲染
}

type Listener = (evt: GameBusEvent) => void;
const channels = new Map<string, Set<Listener>>();

export function subscribeGameChannel(userId: string, fn: Listener): () => void {
  let set = channels.get(userId);
  if (!set) {
    set = new Set();
    channels.set(userId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

export function emitGameEvent(userId: string, evt: GameBusEvent): void {
  const set = channels.get(userId);
  if (set) for (const fn of set) fn(evt);
}
