import type { Channel, Envelope } from "./events.js";

// 有界环形缓冲：时间窗（30 分钟）+ 条数硬上限双保险，过限丢最早。
class RingBuffer<T extends { ts: number }> {
  private items: T[] = [];

  constructor(private readonly cap: number, private readonly windowMs: number) {}

  push(item: T): void {
    this.items.push(item);
    const cutoff = item.ts - this.windowMs;
    // TTL 淘汰（按时间戳）
    while (this.items.length > 0 && this.items[0].ts < cutoff) {
      this.items.shift();
    }
    // 条数淘汰
    while (this.items.length > this.cap) {
      this.items.shift();
    }
  }

  snapshot(): T[] {
    return this.items.slice();
  }
}

const WINDOW_MS = 30 * 60 * 1000;

// runs 通道按"事件条数"留量，cap 取一个能覆盖远超 50 个完整 run 的值
// （单 run ≈ 6-10 事件，2000 条 ≈ 200+ run；真正吃内存的是 prompt 全文，由 30 分钟窗约束）。
const CAPS: Record<Channel, number> = {
  logs: 5000,
  runs: 2000,
  connections: 200,
};

export type Subscriber = (env: Envelope) => void;

class ObserveBus {
  private readonly buffers: Record<Channel, RingBuffer<Envelope>>;
  private readonly subscribers = new Set<Subscriber>();

  constructor() {
    this.buffers = {
      logs: new RingBuffer<Envelope>(CAPS.logs, WINDOW_MS),
      runs: new RingBuffer<Envelope>(CAPS.runs, WINDOW_MS),
      connections: new RingBuffer<Envelope>(CAPS.connections, WINDOW_MS),
    };
  }

  emit(channel: Channel, type: string, payload: unknown): void {
    const env: Envelope = { channel, type, ts: Date.now(), payload };
    this.buffers[channel].push(env);
    // fan-out：单个订阅者异常绝不能阻塞总线或影响其它订阅者
    for (const fn of this.subscribers) {
      try {
        fn(env);
      } catch {
        /* swallow */
      }
    }
  }

  snapshot(channel: Channel): Envelope[] {
    return this.buffers[channel].snapshot();
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}

export const observeBus = new ObserveBus();
