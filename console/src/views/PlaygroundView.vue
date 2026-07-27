<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import {
  listAgents,
  mintToken,
  buildRunBody,
  getAgentJwt,
  setAgentJwt,
  type AgentInfo,
} from "../api";

const agents = ref<AgentInfo[]>([]);
const agentId = ref("");
const userId = ref("tester");
const role = ref("admin");
const claimsText = ref("{}");
const jwtStatus = ref(getAgentJwt() ? "已签发" : "未签发");

const message = ref("");
const response = ref("");
const rawEvents = ref<{ type: string; obj: any }[]>([]);
const running = ref(false);
const error = ref("");
const responseEl = ref<HTMLElement | null>(null);
let controller: AbortController | null = null;

onMounted(async () => {
  try {
    agents.value = await listAgents();
    if (agents.value.length) agentId.value = agents.value[0].id;
  } catch (e: any) {
    error.value = e.message;
  }
});

async function doMint() {
  error.value = "";
  let claims: Record<string, unknown> = {};
  try {
    claims = JSON.parse(claimsText.value || "{}");
  } catch {
    error.value = "claims 不是合法 JSON";
    return;
  }
  try {
    const token = await mintToken(userId.value, role.value, claims);
    setAgentJwt(token);
    jwtStatus.value = `已签发 (${userId.value}/${role.value})`;
  } catch (e: any) {
    error.value = e.message;
  }
}

async function send() {
  error.value = "";
  response.value = "";
  rawEvents.value = [];
  if (!agentId.value) {
    error.value = "选一个 agent";
    return;
  }
  if (!getAgentJwt()) {
    error.value = "先点「签发 token」";
    return;
  }
  if (!message.value.trim()) return;
  running.value = true;
  controller = new AbortController();
  const body = buildRunBody(agentId.value, message.value);

  try {
    const resp = await fetch(`/agent/${encodeURIComponent(agentId.value)}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAgentJwt()}`,
        "X-Observe-Origin": "console",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => "");
      error.value = `HTTP ${resp.status} ${t.slice(0, 200)}`;
      running.value = false;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dl = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""));
        const data = dl.join("\n").trim();
        if (!data || data === "[DONE]") continue;
        try {
          handleEvent(JSON.parse(data));
        } catch {
          /* ignore malformed */
        }
      }
    }
  } catch (e: any) {
    if (e?.name !== "AbortError") error.value = e.message;
  } finally {
    running.value = false;
  }
}

function handleEvent(obj: any) {
  const type = obj?.type ?? obj?.event ?? "";
  rawEvents.value.push({ type, obj });
  const isText =
    type === "TEXT_MESSAGE_CONTENT" ||
    type === "text-delta" ||
    type === "TEXT_MESSAGE_DELTA";
  if (isText) {
    const piece = obj?.delta ?? obj?.content ?? obj?.text;
    if (typeof piece === "string") {
      response.value += piece;
      nextTick(() => {
        if (responseEl.value) responseEl.value.scrollTop = responseEl.value.scrollHeight;
      });
    }
  }
}

function stop() {
  controller?.abort();
}
</script>

<template>
  <div class="pg">
    <section class="card">
      <h3>身份（签发 JWT）</h3>
      <div class="row" style="flex-wrap:wrap">
        <select v-model="agentId">
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.id }}{{ a.hasDag ? " (DAG)" : "" }}</option>
        </select>
        <input v-model="userId" placeholder="userId" style="width:130px" />
        <input v-model="role" placeholder="role" style="width:120px" />
        <button class="primary" @click="doMint">签发 token</button>
        <span class="tag" :class="jwtStatus.startsWith('已') ? 'green' : ''">{{ jwtStatus }}</span>
      </div>
      <textarea v-model="claimsText" placeholder="额外 claims（JSON）" class="claims"></textarea>
    </section>

    <section class="card grow">
      <h3>对话</h3>
      <div class="row">
        <textarea
          v-model="message"
          placeholder="给 agent 发条消息…（Ctrl+Enter 发送）"
          class="msg"
          @keydown.ctrl.enter="send"
        ></textarea>
        <button v-if="!running" class="primary" @click="send">发送</button>
        <button v-else @click="stop">中断</button>
      </div>
      <div v-if="error" class="tag red" style="margin:6px 0">{{ error }}</div>
      <div class="resp-label muted">响应（流式）：</div>
      <div ref="responseEl" class="response scroll">{{ response || (running ? "…" : "（响应将出现在这里，同时 /console/feed 看完整轨迹）") }}</div>
    </section>

    <section class="card">
      <h3>原始 AG-UI 事件 <span class="tag">{{ rawEvents.length }}</span></h3>
      <div class="evlist scroll">
        <div v-for="(e, i) in rawEvents" :key="i" class="ev mono">
          <span class="tag">{{ e.type }}</span>
          <span class="muted small">{{ JSON.stringify(e.obj).slice(0, 200) }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pg { padding: 16px; height: 100%; overflow: auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
.card.grow { display: flex; flex-direction: column; }
h3 { margin: 0 0 8px; font-size: 13px; }
.claims { width: 100%; min-height: 40px; margin-top: 8px; font-family: var(--mono); font-size: 12px; }
.msg { flex: 1; min-height: 60px; resize: vertical; }
.response { white-space: pre-wrap; word-break: break-word; background: #0c0e12; border: 1px solid var(--border); border-radius: 4px; padding: 10px; min-height: 120px; max-height: 320px; font-family: var(--mono); font-size: 12px; }
.resp-label { margin: 8px 0 4px; font-size: 12px; }
.evlist { max-height: 200px; background: #0c0e12; border: 1px solid var(--border); border-radius: 4px; }
.ev { padding: 3px 8px; border-bottom: 1px solid #14171e; display: flex; gap: 6px; align-items: baseline; }
.small { font-size: 11px; }
</style>
