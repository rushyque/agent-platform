// 内存状态管理 —— 按 userId 存 FreightWorld，重启丢失。
// 模式参考 starlink-factory/game/state-store.ts：Map 懒初始化 + 事件总线。
import type { FreightWorld } from './types.js';
import { FORWARDERS } from './world.js';

const stores = new Map<string, FreightWorld>();

export interface FreightWorldEvent {
  type: 'world' | 'reset';
  summary: string;
  world: FreightWorld;
}

type Listener = (evt: FreightWorldEvent) => void;
const channels = new Map<string, Set<Listener>>();

export function createInitialWorld(): FreightWorld {
  return {
    forwarders: FORWARDERS.map((f) => ({ ...f })),
    inquiries: [],
    emails: [],
    evaluations: {},
    decisionLog: [],
    log: [
      {
        timestamp: new Date().toISOString(),
        text: '系统就绪：8 家预设货代已接入，5 个询价场景待用',
        kind: 'system',
      },
    ],
  };
}

export function getWorld(userId: string): FreightWorld {
  let w = stores.get(userId);
  if (!w) {
    w = createInitialWorld();
    stores.set(userId, w);
  }
  return w;
}

export function resetWorld(userId: string): FreightWorld {
  const w = createInitialWorld();
  stores.set(userId, w);
  return w;
}

export function subscribeFreightChannel(userId: string, fn: Listener): () => void {
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

// 推送前克隆全量 world，避免前端拿到被后续 mutate 的引用（参考 starlink engine.emit）
export function emitFreightWorld(userId: string, summary: string): void {
  const world = getWorld(userId);
  const snapshot = JSON.parse(JSON.stringify(world)) as FreightWorld;
  const set = channels.get(userId);
  if (set) for (const fn of set) fn({ type: 'world', summary, world: snapshot });
}

// 全局自增 ID（测试项目，重启从 0；多用户共享不冲突，各看各的列表）
let inquiryCounter = 0;
export function nextInquiryId(): string {
  inquiryCounter++;
  return `INQ-26-${String(inquiryCounter).padStart(4, '0')}`;
}

let emailCounter = 0;
export function nextEmailId(): string {
  emailCounter++;
  return `E-${String(emailCounter).padStart(5, '0')}`;
}
