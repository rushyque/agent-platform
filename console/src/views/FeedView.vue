<script setup lang="ts">
import { ref } from "vue";
import { useObserveStream } from "../composables/useObserveStream";
import LogsPanel from "../components/LogsPanel.vue";
import RunsPanel from "../components/RunsPanel.vue";
import RunTrace from "../components/RunTrace.vue";
import ConnectionsPanel from "../components/ConnectionsPanel.vue";

const { state } = useObserveStream();
const selectedRun = ref<string | null>(null);
</script>

<template>
  <div class="feed">
    <div class="pane"><LogsPanel :logs="state.logs" /></div>
    <div class="pane narrow"><RunsPanel :runs="state.runs" :selected="selectedRun" @select="(id) => (selectedRun = id)" /></div>
    <div class="pane"><RunTrace :runs="state.runs" :run-id="selectedRun" /></div>
    <div class="pane narrow"><ConnectionsPanel :connections="state.connections" /></div>
  </div>
</template>

<style scoped>
.feed {
  display: grid;
  grid-template-columns: 2.2fr 1fr 1.6fr 1fr;
  height: 100%;
  gap: 1px;
  background: var(--border);
}
.pane { background: var(--panel); padding: 8px; min-width: 0; }
.pane.narrow { min-width: 0; }
</style>
