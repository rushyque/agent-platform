<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { useObserveStream } from "./composables/useObserveStream";

const { state, connect } = useObserveStream();
onMounted(() => connect());
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">Agent Platform · 观察控制台</div>
      <nav class="nav">
        <RouterLink to="/feed">实时 Feed</RouterLink>
        <RouterLink to="/agents">Agents</RouterLink>
        <RouterLink to="/playground">Playground</RouterLink>
      </nav>
      <div class="status">
        <span class="dot" :class="{ on: state.connected }"></span>
        <span class="muted">{{ state.connected ? "已连接" : "连接中…" }}</span>
      </div>
    </header>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100%; }
.topbar {
  display: flex; align-items: center; gap: 24px;
  padding: 0 16px; height: 44px;
  background: var(--panel); border-bottom: 1px solid var(--border);
}
.brand { font-weight: 600; }
.nav { display: flex; gap: 4px; }
.nav a {
  padding: 4px 10px; border-radius: 4px; color: var(--muted);
  text-decoration: none;
}
.nav a.router-link-active { color: var(--text); background: var(--panel-2); }
.status { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); }
.dot.on { background: var(--green); }
.main { flex: 1; min-height: 0; overflow: hidden; }
</style>
