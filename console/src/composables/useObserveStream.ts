import { reactive } from "vue";
import { getAdminToken } from "../api";

export interface Envelope {
  channel: "logs" | "runs" | "connections";
  type: string;
  ts: number;
  payload: any;
  replay?: boolean;
}

const MAX_PER_CHANNEL = 1000;

// 模块级单例：所有组件共享同一份实时状态。
const state = reactive({
  logs: [] as Envelope[],
  runs: [] as Envelope[],
  connections: [] as Envelope[],
  connected: false,
});

let es: EventSource | null = null;

function push(ch: "logs" | "runs" | "connections", env: Envelope): void {
  const arr = state[ch];
  arr.push(env);
  if (arr.length > MAX_PER_CHANNEL) arr.splice(0, arr.length - MAX_PER_CHANNEL);
}

export function useObserveStream() {
  function connect(): void {
    if (es) return;
    const t = getAdminToken();
    const url = t ? `/observe/stream?token=${encodeURIComponent(t)}` : "/observe/stream";
    es = new EventSource(url);
    es.onopen = () => {
      state.connected = true;
    };
    es.onerror = () => {
      state.connected = false;
      // EventSource 会自动重连，无需手动处理
    };
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as Envelope;
        if (env.channel === "logs" || env.channel === "runs" || env.channel === "connections") {
          push(env.channel, env);
        }
      } catch {
        /* ignore malformed */
      }
    };
  }

  function clear(ch?: "logs" | "runs" | "connections"): void {
    if (ch) state[ch].splice(0, state[ch].length);
    else {
      state.logs.splice(0, state.logs.length);
      state.runs.splice(0, state.runs.length);
      state.connections.splice(0, state.connections.length);
    }
  }

  return { state, connect, clear };
}
