// 前端 API 封装。两类 token：
// - adminToken：OBSERVE_TOKEN 门控（prod 配置时才需要），存 localStorage，附在 ?token= 上。
// - agentJwt：Playground mint 出来的 agent 身份 token，作为 Authorization: Bearer 调 /agent/*。

const ADMIN_KEY = "observe_admin_token";
const AGENT_KEY = "observe_agent_jwt";

export function getAdminToken(): string | null {
  return localStorage.getItem(ADMIN_KEY);
}
export function setAdminToken(t: string | null): void {
  if (t) localStorage.setItem(ADMIN_KEY, t);
  else localStorage.removeItem(ADMIN_KEY);
}
export function getAgentJwt(): string | null {
  return localStorage.getItem(AGENT_KEY);
}
export function setAgentJwt(t: string | null): void {
  if (t) localStorage.setItem(AGENT_KEY, t);
  else localStorage.removeItem(AGENT_KEY);
}

function adminQuery(): string {
  const t = getAdminToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
}

export interface AgentInfo {
  id: string;
  description: string;
  hasDag: boolean;
}

export async function listAgents(): Promise<AgentInfo[]> {
  const r = await fetch(`/console/api/agents${adminQuery()}`);
  if (!r.ok) throw new Error(`listAgents: HTTP ${r.status}`);
  return (await r.json()).agents as AgentInfo[];
}

export async function mintToken(
  userId: string,
  role: string,
  claims?: Record<string, unknown>
): Promise<string> {
  const r = await fetch(`/console/api/mint-token${adminQuery()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, role, claims }),
  });
  if (!r.ok) throw new Error(`mintToken: HTTP ${r.status}`);
  return (await r.json()).token as string;
}

// AG-UI /agent/{id}/run 请求体（与 src/bench/probes.ts probeE2E 对齐）
export function buildRunBody(agentId: string, message: string) {
  const id = crypto.randomUUID();
  return {
    threadId: `playground-${id}`,
    runId: `playground-${id}`,
    messageId: `playground-msg-${id}`,
    messages: [{ id: `playground-msg-${id}`, role: "user", content: message }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
}
