# Agent Platform

基于 [CopilotKit](https://github.com/CopilotKit/CopilotKit)（AG-UI 协议）构建的 **Agent 中台**，用 TypeScript 重新实现，支持多项目接入。平台只负责"怎么传"，不定义业务语义；每个接入项目按 `AgentConfig` 契约提供自己的工具、prompt 和上下文解析。

> 设计背景与完整方案见 [PLAN.md](./PLAN.md)，对外对接规范见 [docs/对接规范.md](./docs/对接规范.md)，**控制台完整使用说明（从 LLM 基础到每个面板）见 [docs/观察控制台说明书.md](./docs/观察控制台说明书.md)**。

---

## 核心理念

1. **平台只管"怎么传"，不管"传什么"** — 平台不解读 `role`/`scope`/`department` 等业务字段，项目自己决定 context 里放什么。
2. **Harness 承载 Hermes** — 平台 Runtime 是 Harness（代码控制流程），项目 Agent 默认走 Hermes（LLM 自主 function calling），复杂多步场景按需升级为 DAG 编排。
3. **简单性层级** — 从 Hermes 开始，有测量证据（模型频繁犯错、需要确定性编排）时才引入 DAG。
4. **权限双层面** — 模型权限意识（prompt 注入）+ 工具内部硬校验（返回结构化错误，不抛异常）。

---

## 功能特性

- **AgentConfig 路由** — 按 `/agent/{agentId}` 分发到项目 Agent，平台核心不依赖任何具体项目。
- **两种执行模式** — Hermes（`BuiltInAgent` + `streamText`）/ Harness（`DAGAgent` + 检查点）。
- **上下文管理** — 工具结果外置到 artifact 表，context 里只回 `{ref, toolName, summary}`；模型需要完整数据时主动调用 `getArtifact(ref)` 取回，避免上下文膨胀。配合压缩 / 折叠 / 线程摘要，治理长会话幻觉。
- **会话持久化** — `DatabaseAgentRunner` 把 AG-UI 事件落到 MSSQL，`connect` 端点可恢复历史（event sourcing）。
- **按意图选择工具子集** — `5 个聚焦工具 > 20 个工具`，项目可在 `AgentConfig.classifyIntent` / `selectTools` 自定义。
- **实时观察控制台** — `/console` Vue SPA：Playground（签发身份 → 触发 run → 流式响应）+ 实时 Feed（结构化日志 / run 逐步轨迹 / 连接，单条多路复用 SSE）+ Agent 注册表。详见下文。
- **结构化日志** — 全仓统一 `logger.for(source)`，双 sink（终端 + 观察 SSE），按 run 自动归属。
- **调试控制台** — `/debug` 单文件只读页（轨迹 / 线程回放 / 消息历史）。交互式观察用 `/console`。
- **并发压测** — `/bench` 页驱动多路并发 run，记录流式速率曲线。

---

## 目录结构

```
agent-platform/
├── src/
│   ├── server.ts                # 入口：CopilotRuntime + HTTP 服务 + 调试/bench/项目路由
│   ├── config/settings.ts       # zod 校验的环境配置
│   ├── core/
│   │   ├── agent-router.ts      # agentId → AgentConfig 路由
│   │   ├── http-router.ts       # 项目自有 HTTP 路由聚合
│   │   ├── llm.ts               # DeepSeek 客户端（含 reasoning 中间件）
│   │   ├── context/             # 上下文管理：压缩/折叠/摘要/artifact 外置
│   │   ├── dag/                 # DAGAgent（Harness 模式）+ 检查点
│   │   └── middleware/          # auth / logging / tool-injector
│   ├── observe/                 # 实时观察层：SSE 总线 / logger / ALS / runs+connections 生产者
│   ├── persistence/             # MSSQL：thread / run / event / database-runner
│   ├── bench/                   # 并发压测路由与探测
│   ├── projects/                # 项目适配层（接入点）
│   │   ├── freight-inquiry/     # 货运询比价（多货代询价 → AI 解析报价 → 偏好评估）
│   │   └── starlink-factory/    # 星联模具工厂运营游戏（验证中台驱动新领域）
│   └── types/agent-config.ts    # AgentConfig / ToolDefinition / AgentContext 契约
├── console/                     # 观察控制台 SPA（Vite + Vue3，构建产物 console/dist 由中台在 /console 托管）
├── public/                      # 单文件前端页：bench / debug / game / inquiry
├── docs/对外对接规范.md
├── PLAN.md                      # 设计方案
├── Dockerfile
└── package.json
```

---

## AgentConfig 接入契约

平台定义接口，项目提供实现：

```ts
interface AgentConfig {
  agentId: string;
  description?: string;
  model?: string;                              // 可选：项目指定模型，缺省走平台 DEEPSEEK_MODEL

  // 平台从 JWT 拿到 userId/token，项目自己决定返回什么 context
  resolveContext: (req: { userId; token; headers }) => Promise<AgentContext>;

  // 项目自己决定暴露哪些工具（Zod schema + execute）
  tools: ToolDefinition[];

  // 项目自己决定模型看到什么指令
  buildSystemPrompt: (params: { context; messages; intent }) => string;

  // 可选：意图分类与工具子集选择（缺省 intent="general"，全量工具）
  classifyIntent?: (params: { messages; context }) => string;
  selectTools?: (params: { intent; allTools; context }) => ToolDefinition[];

  // 可选：复杂场景的 DAG 编排（启用后走 DAGAgent / Harness 模式）
  dagDefinition?: DAGDefinition;
}
```

注册一个项目只需两步（见 [src/projects/index.ts](./src/projects/index.ts)）：

```ts
registerAgent(myAgentConfig);            // agent 路由
registerProjectRoutes("/my", myRoutes);  // 项目自有 HTTP 路由（可选）
```

---

## 快速开始

### 环境要求

- Node.js ≥ 18
- 一个可达的 MSSQL 实例（事件持久化用；DB 不可用时服务仍能启动，按请求降级）
- DeepSeek 兼容的 OpenAI API 端点

### 安装

```bash
npm install
```

### 配置环境变量

`.env` 已被 `.gitignore` 排除，请在项目根目录新建：

```ini
# LLM（DeepSeek 兼容 OpenAI 协议）
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=http://your-llm-endpoint/v1

# Runtime
RUNTIME_PORT=9876
RUNTIME_HOST=127.0.0.1
COPILOTKIT_TELEMETRY_DISABLED=true   # 关闭遥测，保留 /threads 本地端点

# MSSQL（事件持久化）
DB_HOST=...
DB_PORT=1433
DB_USER=...
DB_PASSWORD=...
DB_NAME=agent_platform

# JWT（认证中间件）
JWT_SECRET=...

# 观察控制台（/console）；默认开启，prod 可设 OBSERVE_TOKEN 限制访问
OBSERVE_ENABLED=true
OBSERVE_TOKEN=                   # 可选；设置后 /observe/stream 与 /console/api/* 需带 ?token=
```

### 运行

```bash
npm run dev     # tsx watch 热重载
npm run build   # tsc → dist/
npm start       # node dist/server.js
```

启动后日志会打印监听地址、LLM 端点和已注册的 agent 列表。

> 要用观察控制台 `/console`，还需构建前端（一次性）：`npm --prefix console install && npm --prefix console run build`。详见下方「观察控制台」一节。

---

## HTTP 端点

| 路径 | 说明 |
|------|------|
| `/agent/{agentId}` | CopilotKit multi-route 入口，`run` / `connect` 等 AG-UI 端点 |
| `/console` | **观察控制台 SPA**（Playground / 实时 Feed / Agents） |
| `/observe/stream` | 多路复用 SSE（`logs` / `runs` / `connections` 通道） |
| `/console/api/*` | 控制台后端 API：`agents`（注册表）、`mint-token`（签发 JWT） |
| `/game` | 星联工厂游戏前端页 + 游戏状态 HTTP 路由 |
| `/inquiry` | 货运询比价前端页 |
| `/debug` | 调试控制台（轨迹 / 线程回放 / 只读 API） |
| `/bench` | 并发压测页 |

> 平台不兜底到任何项目：未指定 `agentId` 或 agent 未注册时，会返回明确的错误消息而非静默回退。

---

## 观察控制台（`/console`）

实时观察中台运行——既是**请求方**（主动触发 run），又是**观察者**（看日志 / LLM I/O / 工具执行 / 连接）。独立 Vue 3 SPA（`console/`），构建后由中台在 `/console` 静态托管。

### 构建与访问

```bash
# 1) 构建前端（首次或改完 console/ 后）
npm --prefix console install
npm --prefix console run build        # 产物 console/dist，由中台在 /console 托管

# 2) 起中台
npm run dev

# 3) 浏览器打开
http://<RUNTIME_HOST>:<RUNTIME_PORT>/console
```

开发模式（SPA 热重载，反代到本地中台）：

```bash
npm --prefix console run dev          # Vite 起在 5174，/observe /agent /console/api 反代到中台
# 默认代理 http://127.0.0.1:9876，可用 VITE_BACKEND=http://192.168.1.155:9876 覆盖
```

### 三个视图

- **实时 Feed**（`/console/feed`）—— 四栏实时活动流，全部来自 `/observe/stream` 多路复用 SSE：
  - **Logs**：全仓结构化日志（按 source / level / runId / data 过滤）。带 `replay` 标记的是连上时回放的历史，之后是实时。
  - **Runs**：run 列表（路由 / 意图 / 状态 / 耗时）。点开右侧 **Trace** 看**逐步轨迹**：`run.started` → `llm_call`（system prompt 全文 + messages）→ `tool_call` / `tool_result`（args / execMs / summary / artifact ref）→ `llm_response`（原始响应文本 + token 用量）→ `run.finished`。
  - **连接**：`/agent/*` 与项目路由的请求（method / path / 状态 / 耗时 / 来源 IP；控制台自己发的请求标 `console`）。
- **Agents**（`/console/agents`）—— 中台已注册的 AgentConfig 清单（Hermes / DAG）。
- **Playground**（`/console/playground`）—— 当请求方，三步：
  1. 选 agent + 填 `userId` / `role`（+ 可选 claims JSON）→ **签发 token**：中台用 `JWT_SECRET` 现签一个 JWT（正好测「权限双层面」——随便造 role）。
  2. 填消息 → **发送**（或 Ctrl+Enter）→ 前端 POST `/agent/{id}/run`，流式接收响应。
  3. 响应区看流式文本，下方「原始 AG-UI 事件」看完整 SSE 事件流；该 run 的**内部轨迹**（工具调用、LLM prompt/response、折叠）在「实时 Feed」的 Trace 里同步出现。

### 实时通道（不落库）

`/observe/stream` 是单条多路复用 SSE，envelope `{channel, type, ts, payload, replay?}`，`channel ∈ logs | runs | connections`。前端连上先回放每通道最近 30 分钟环形缓冲（`replay:true`），再续实时。**观察层零 DB**——重启即清零，无长窗口历史；要看一个「过去的 run」，用 Playground 同条件重跑即可。

### 访问控制

默认开启（`OBSERVE_ENABLED=true`）。prod 可设 `OBSERVE_TOKEN=xxx`：届时 `/observe/stream` 与 `/console/api/*` 需带 `?token=xxx` 或 `Authorization: Bearer xxx`（控制台把 admin token 存 localStorage 自动附上）；`OBSERVE_ENABLED=false` 整层关闭、相关路径返回 404。

---

## 已接入项目

- **starlink-factory** — 星联模具工厂运营游戏。验证中台能否驱动非传统业务领域（车间 / 流水线 / 手感动画）。
- **freight-inquiry** — 货运询比价。多货代询价 → AI 解析报价邮件 → AI 按偏好评估推荐；工具内 `generateObject` 的首个业务实例。
