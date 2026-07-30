<script setup lang="ts">
import { computed } from "vue";
import type { Envelope } from "../composables/useObserveStream";

const props = defineProps<{ runs: Envelope[]; selected: string | null }>();
const emit = defineEmits<{ (e: "select", id: string): void; (e: "clear"): void }>();

const runList = computed(() => {
  const map = new Map<string, any>();
  for (const e of props.runs) {
    if (e.type === "run.started") {
      map.set(e.payload.runId, {
        runId: e.payload.runId,
        agentId: e.payload.agentId,
        route: e.payload.route,
        intent: e.payload.intent,
        role: e.payload.role,
        startedTs: e.ts,
        finished: null as any,
        finishedTs: null as number | null,
      });
    }
  }
  for (const e of props.runs) {
    if (e.type === "run.finished") {
      const r = map.get(e.payload.runId);
      if (r) { r.finished = e.payload; r.finishedTs = e.ts; }
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
      <span class="muted">Runs</span>
      <span class="tag">{{ runList.length }}</span>
      <button class="btn-mini" @click="emit('clear')" title="清空 runs">清空</button>
    </div>
    <div class="scroll list">
      <div
        v-for="r in runList"
        :key="r.runId"
        class="ritem"
        :class="{ active: r.runId === selected }"
        @click="emit('select', r.runId)"
      >
        <div class="row" style="flex-wrap:wrap; gap:4px">
          <span class="tag" :class="r.route === 'dag' ? 'amber' : 'blue'">{{ r.route }}</span>
          <span class="tag">{{ r.agentId }}</span>
          <span v-if="r.intent" class="tag">{{ r.intent }}</span>
          <span v-if="r.finished" class="tag" :class="r.finished.status === 'error' ? 'red' : 'green'">{{ r.finished.status }}</span>
        </div>
        <div class="muted mono small">
          {{ r.runId.slice(0, 13) }} · {{ ts(r.startedTs) }}
          <span v-if="r.finished"> · {{ r.finished.durationMs }}ms</span>
        </div>
      </div>
      <div v-if="!runList.length" class="muted small empty">尚无 run<br />去 Playground 发条消息</div>
    </div>
  </div>
</template>

<style scoped>
.panel { height: 100%; }
.head { padding-bottom: 6px; }
.list { flex: 1; min-height: 0; }
.ritem { padding: 6px 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
.ritem:hover { background: var(--panel-2); }
.ritem.active { background: #1c2735; border-left: 2px solid var(--accent); }
.small { font-size: 11px; }
.empty { padding: 16px 8px; line-height: 1.6; }
.btn-mini { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 1px 6px; font-size: 11px; font-family: var(--mono); cursor: pointer; border-radius: 3px; }
.btn-mini:hover { color: var(--text); border-color: var(--accent); }
</style>
