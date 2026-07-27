<script setup lang="ts">
import { ref, onMounted } from "vue";
import { listAgents, type AgentInfo } from "../api";

const agents = ref<AgentInfo[]>([]);
const error = ref("");

onMounted(async () => {
  try {
    agents.value = await listAgents();
  } catch (e: any) {
    error.value = e.message;
  }
});
</script>

<template>
  <div class="page scroll">
    <h2>注册的 Agents <span class="tag">{{ agents.length }}</span></h2>
    <div v-if="error" class="tag red">{{ error }}</div>
    <div v-for="a in agents" :key="a.id" class="card">
      <div class="row">
        <span class="tag blue mono">{{ a.id }}</span>
        <span class="tag" :class="a.hasDag ? 'amber' : 'green'">{{ a.hasDag ? "DAG (Harness)" : "Hermes" }}</span>
      </div>
      <p class="desc">{{ a.description }}</p>
    </div>
    <p class="muted small hint">
      Agent 列表来自中台 AgentConfig 注册表（内存）。到这里还没发请求？去
      <RouterLink to="/playground">Playground</RouterLink> 触发一个 run，再到
      <RouterLink to="/feed">实时 Feed</RouterLink> 看轨迹。
    </p>
  </div>
</template>

<style scoped>
.page { padding: 16px; }
h2 { margin: 0 0 12px; font-size: 15px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 8px; }
.desc { margin: 8px 0 0; color: var(--muted); }
.small { font-size: 12px; }
.hint { margin-top: 16px; }
.hint a { color: var(--accent); }
</style>
