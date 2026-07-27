<script setup lang="ts">
import { computed } from "vue";
import type { Envelope } from "../composables/useObserveStream";

const props = defineProps<{ connections: Envelope[] }>();

const items = computed(() => {
  const map = new Map<string, any>();
  for (const e of props.connections) {
    if (e.type === "request.started") {
      map.set(e.payload.reqId, { ...e.payload, startedTs: e.ts, finished: null as any });
    }
  }
  for (const e of props.connections) {
    if (e.type === "request.finished") {
      const it = map.get(e.payload.reqId);
      if (it) it.finished = e.payload;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.startedTs - a.startedTs);
});

function ts(t: number): string {
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="col panel">
    <div class="head row">
      <span class="muted">连接</span>
      <span class="tag">{{ items.length }}</span>
    </div>
    <div class="scroll list">
      <div v-for="it in items" :key="it.reqId" class="ritem">
        <div class="row" style="flex-wrap:wrap; gap:4px">
          <span class="tag mono" :class="it.method === 'POST' ? 'blue' : ''">{{ it.method }}</span>
          <span class="mono small path">{{ it.path }}</span>
          <span v-if="it.origin === 'console'" class="tag green">console</span>
          <span v-if="it.finished" class="tag" :class="it.finished.status >= 400 ? 'red' : ''">{{ it.finished.status }}</span>
          <span v-else class="tag amber">…</span>
        </div>
        <div class="muted mono small">
          {{ ts(it.startedTs) }}<span v-if="it.finished"> · {{ it.finished.durationMs }}ms</span>
          <span v-if="it.agentId"> · agent={{ it.agentId }}</span>
          <span v-if="it.userId"> · user={{ it.userId }}</span>
          <span v-if="it.ip"> · {{ it.ip }}</span>
        </div>
      </div>
      <div v-if="!items.length" class="muted small empty">尚无请求<br />（仅 /agent/* 与项目路由记录）</div>
    </div>
  </div>
</template>

<style scoped>
.panel { height: 100%; }
.head { padding-bottom: 6px; }
.list { flex: 1; min-height: 0; }
.ritem { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.ritem:hover { background: var(--panel-2); }
.path { word-break: break-all; }
.small { font-size: 11px; }
.empty { padding: 16px 8px; line-height: 1.6; }
</style>
