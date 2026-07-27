<script setup lang="ts">
import { computed } from "vue";
import type { Envelope } from "../composables/useObserveStream";

const props = defineProps<{ runs: Envelope[]; runId: string | null }>();

const events = computed(() =>
  props.runId ? props.runs.filter((e) => e.payload.runId === props.runId) : []
);

function ts(t: number): string {
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(t % 1000).padStart(3, "0");
}
function typeClass(t: string): string {
  if (t === "run.started") return "blue";
  if (t === "run.finished") return "";
  if (t === "run.tool_call" || t === "run.tool_result") return "amber";
  if (t === "run.step") return "";
  return "";
}
function shortType(t: string): string {
  return t.replace("run.", "");
}
</script>

<template>
  <div class="col panel">
    <div class="head row">
      <span class="muted">Trace</span>
      <span v-if="runId" class="tag mono">{{ runId.slice(0, 13) }}</span>
    </div>
    <div class="scroll list">
      <div v-for="(e, i) in events" :key="i" class="ev">
        <div class="row" style="gap:6px">
          <span class="ts muted mono">{{ ts(e.ts) }}</span>
          <span class="tag mono" :class="typeClass(e.type)">{{ shortType(e.type) }}</span>
        </div>
        <pre v-if="e.type === 'run.started'" class="body">{{ JSON.stringify({ agentId: e.payload.agentId, route: e.payload.route, intent: e.payload.intent, role: e.payload.role, model: e.payload.model, selectedTools: e.payload.selectedTools }, null, 2) }}</pre>
        <pre v-else-if="e.type === 'run.finished'" class="body">{{ JSON.stringify(e.payload, null, 2) }}</pre>
        <pre v-else-if="e.type === 'run.llm_call'" class="body muted">systemPrompt {{ (e.payload.systemPrompt || '').length }} chars · {{ (e.payload.messages || []).length }} msgs · step {{ e.payload.stepIndex }}</pre>
        <pre v-else-if="e.type === 'run.llm_response'" class="body">{{ e.payload.rawText }}</pre>
        <pre v-else-if="e.type === 'run.tool_call'" class="body">{{ e.payload.toolName }}({{ JSON.stringify(e.payload.args) }})</pre>
        <pre v-else-if="e.type === 'run.tool_result'" class="body">{{ JSON.stringify({ toolName: e.payload.toolName, execMs: e.payload.execMs, summary: e.payload.summary, ref: e.payload.ref }) }}</pre>
        <pre v-else-if="e.type === 'run.step'" class="body muted">step {{ e.payload.stepIndex }} · type={{ e.payload.type }} · id={{ e.payload.stepId }}</pre>
        <pre v-else class="body muted">{{ JSON.stringify(e.payload) }}</pre>
      </div>
      <div v-if="!events.length" class="muted small empty">
        {{ runId ? "该 run 暂无事件" : "左侧选一个 run 查看轨迹" }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { height: 100%; }
.head { padding-bottom: 6px; }
.list { flex: 1; min-height: 0; }
.ev { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.body { margin: 4px 0 0; font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; color: var(--text); }
.body.muted { color: var(--muted); }
.small { font-size: 11px; }
.empty { padding: 16px 8px; }
</style>
