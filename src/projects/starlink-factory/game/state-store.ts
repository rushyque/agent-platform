// 游戏状态存储 —— 按 userId 的进程内单例（重启丢失；持久化留作后续）。
import type { GameState } from "./types.js";
import { createInitialState } from "./world.js";

const stores = new Map<string, GameState>();

export function getGameState(userId: string): GameState {
  let s = stores.get(userId);
  if (!s) {
    s = createInitialState(userId);
    stores.set(userId, s);
  }
  return s;
}

export function resetGameState(userId: string): GameState {
  const s = createInitialState(userId);
  stores.set(userId, s);
  return s;
}
