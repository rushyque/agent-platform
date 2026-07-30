<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import type { Envelope } from "../composables/useObserveStream";

const props = defineProps<{ logs: Envelope[] }>();
const emit = defineEmits<{ (e: "clear"): void }>();
const filter = ref("");
const levelFilter = ref("");
const container = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return props.logs.filter((e) => {
    const p = e.payload;
    if (levelFilter.value && p.level !== levelFilter.value) return false;
    if (!f) return true;
    return (
      String(p.source || "").toLowerCase().includes(f) ||
      String(p.msg || "").toLowerCase().includes(f) ||
      String(p.runId || "").toLowerCase().includes(f) ||
      JSON.stringify(p.data || {}).toLowerCase().includes(f)
    );
  });
});

function onScroll() {
  const el = container.value;
  if (!el) return;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
watch(
  () => filtered.value.length,
  async () => {
    if (autoScroll.value) {
      await nextTick();
      if (container.value) container.value.scrollTop = container.value.scrollHeight;
    }
  }
);
function levelClass(l: string): string {
  return l === "error" ? "red" : l === "warn" ? "amber" : l === "debug" ? "" : "blue";
}
function ts(t: number): string {
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(t % 1000).padStart(3, "0");
}
</script>

<template>
  <div class="col panel">
    <div class="head row">
      <span class="muted">Logs</span>
      <input v-model="filter" placeholder="过滤 source/msg/runId/data…" style="flex:1; min-width:0" />
      <select v-model="levelFilter">
        <option value="">全部</option>
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <span class="tag">{{ filtered.length }}</span>
      <button class="btn-mini" @click="emit('clear')" title="清空日志">清空</button>
    </div>
    <div ref="container" class="loglist scroll" @scroll="onScroll">
      <div v-for="(e, i) in filtered" :key="i" class="logline" :class="e.payload.level">
        <span class="ts muted">{{ ts(e.ts) }}</span>
        <span v-if="e.replay" class="tag">replay</span>
        <span class="tag" :class="levelClass(e.payload.level)">{{ e.payload.level }}</span>
        <span class="tag">{{ e.payload.source }}</span>
        <span v-if="e.payload.runId" class="tag blue">{{ String(e.payload.runId).slice(0, 8) }}</span>
        <span class="msg">{{ e.payload.msg }}</span>
        <span v-if="e.payload.data && Object.keys(e.payload.data).length" class="data muted">{{ JSON.stringify(e.payload.data) }}</span>
      </div>
      <div v-if="!filtered.length" class="muted small empty">尚无日志</div>
    </div>
  </div>
</template>

<style scoped>
.panel { height: 100%; }
.head { gap: 6px; padding-bottom: 6px; }
.loglist { flex: 1; min-height: 0; font-family: var(--mono); font-size: 12px; }
.logline { padding: 2px 8px; display: flex; gap: 6px; align-items: baseline; border-bottom: 1px solid #14171e; }
.logline.error { background: #2a1517; }
.logline.warn { background: #2a2317; }
.logline:hover { background: var(--panel-2); }
.ts { flex-shrink: 0; }
.msg { white-space: pre-wrap; word-break: break-word; }
.data { margin-left: auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.small { font-size: 11px; }
.empty { padding: 16px 8px; }
.btn-mini { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 1px 6px; font-size: 11px; font-family: var(--mono); cursor: pointer; border-radius: 3px; }
.btn-mini:hover { color: var(--text); border-color: var(--accent); }
</style>
