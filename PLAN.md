# CopilotKit Agent 中台设计方案

## Context

SalesHub 现有的 Python AI Agent 存在多个架构问题：
- Python 技术栈过重（PaddleOCR + LangChain + tiktoken + PyMuPDF），安装包 GB 级别
- ReAct 循环 + XML 正则解析 LLM 输出，脆弱且效果有限
- 17 个 API 硬编码在 agent 内部，prompt 里重复维护调度表
- 业务逻辑散落在前端/NestJS/Python 三层，DTO 契约不匹配，聊天记录双写
- Agent 无认证，工具选择靠 prompt 里硬编码
- 非单项目设计，无法复用

目标：基于 CopilotKit (AG-UI 协议) 用 TS/JS 重新构建为独立中台，支持多项目接入。OCR 独立化为微服务保留 Python。遵循 Anthropic 简单性层级原则，按需增加复杂度。

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  前端层 (各项目独立)                                          │
│  copilotkit-vue (npm 版本) + 项目自定义 useRenderTool 组件    │
│  + useAgentContext 注入项目上下文                              │
└──────────────────────┬──────────────────────────────────────┘
                       │ AG-UI Protocol (SSE)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  中台 Runtime (本文档核心)                                     │
│                                                             │
│  基于 CopilotKit Runtime 构建，扩展以下能力:                    │
│  ├── 认证中间件 (JWT 解析 → 传递给项目适配层)                    │
│  ├── AgentConfig 路由 (按 agentId 分发到项目 Agent)              │
│  ├── Prompt Engine (项目提供模板，Runtime 负责组装调用)          │
│  ├── 工具注册中心 (项目注册 Server Tool，按 agentId 隔离)       │
│  ├── 中间件管道 (before_model / modify / after_model)        │
│  └── DatabaseAgentRunner (替代 InMemory，持久化 + connect)     │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌────────────┐
│ SalesHub     │ │ HR 系统   │ │ 未来项目    │
│ AgentConfig  │ │ AgentCfg │ │ AgentConfig │
│ + Tools      │ │ + Tools  │ │ + Tools     │
│ + Prompts    │ │ + Prompt │ │ + Prompts   │
└──────────────┘ └──────────┘ └────────────┘
```

### 核心设计原则

1. **平台只管"怎么传"，不管"传什么"** — 平台不定义 role/department/clearance 等业务概念
2. **Harness 型基础设施，承载 Hermes 型 Agent** — Runtime 是 Harness（代码控制流程），项目 Agent 默认是 Hermes（LLM 自主决策），复杂场景按需升级为 Harness（DAG 编排）
3. **简单性层级** — 从 Hermes (function calling) 开始，有测量证据时才引入 DAG
4. **权限双层面** — 模型权限意识（prompt 注入）+ 工具权限校验（execute 内部），都是项目适配层的责任

---

## 二、AgentConfig — 项目接入契约

平台定义接口，项目提供实现。每个接入中台的系统实现一个 AgentConfig：

```ts
// 平台定义（通用，不含业务语义）
interface AgentConfig {
  agentId: string

  // 上下文解析：平台从 JWT 中拿到 userId/token，项目自己决定返回什么
  resolveContext: (request: {
    userId: string
    token: string
  }) => Promise<Record<string, any>>

  // 工具集：项目自己决定暴露哪些工具
  tools: ToolDefinition[]

  // Prompt 构建：项目自己决定模型看到什么指令
  buildSystemPrompt: (params: {
    context: Record<string, any>  // resolveContext 的返回值
    messages: Message[]           // 当前对话历史（用于意图分类）
  }) => string

  // 可选：复杂场景的 DAG 执行器
  dagExecutor?: DAGExecutorConfig

  // 可选：模型配置（项目可以指定自己的模型）
  model?: string
}

interface ToolDefinition {
  name: string
  description: string
  parameters: ZodSchema            // Zod schema
  execute: (args: any, context: Record<string, any>) => Promise<any>
}
```

### 平台内部流转

```ts
async function handleRun(request: RunAgentInput, config: AgentConfig) {
  // 1. 解析上下文（调项目的函数）
  const context = await config.resolveContext({
    userId: request.userId,
    token: request.token
  })

  // 2. 构建 system prompt（调项目的函数）
  const systemPrompt = config.buildSystemPrompt({ context, messages: request.messages })

  // 3. 透传 context 到每个工具
  const tools = config.tools.map(tool => ({
    ...tool,
    execute: (args) => tool.execute(args, context)  // context 透传
  }))

  // 4. 调 LLM（平台负责流式输出和事件协议）
  return streamText({ model: config.model, system: systemPrompt, messages, tools })
}
```

平台不解读 context 的任何字段。SalesHub 返回 `{ role, scope }`，HR 系统返回 `{ department, clearance }` —— 平台一视同仁。

---

## 三、工具设计

### 3.1 工具注册方式

```ts
// 项目层定义工具
const queryOrdersTool: ToolDefinition = {
  name: "saleshub_query_orders",
  description: "查询订单信息，支持按客户、日期、状态筛选",
  parameters: z.object({
    customer_name: z.string().optional(),
    date_from: z.string().optional(),
    status: z.enum(["pending", "processing", "completed"]).optional(),
  }),
  execute: async (args, context) => {
    // 工具内部根据 context 做权限校验
    if (context.dataScope === "own") {
      args.salesperson_id = context.userId
    }
    return await nestJSAPI.get("/api/orders", { params: args })
  }
}
```

### 3.2 工具权限校验

工具被拒绝时返回结构化错误（而非抛异常），让模型理解原因并给用户有意义的回复：

```ts
const approveRemittanceTool: ToolDefinition = {
  name: "saleshub_approve_remittance",
  parameters: z.object({ remittance_id: z.string(), action: z.enum(["approve", "reject"]) }),
  execute: async (args, context) => {
    if (!["remittance_manager", "admin"].includes(context.role)) {
      return {
        status: "permission_denied",
        message: "当前角色无权审核汇款",
        suggestion: "请联系汇款管理员或系统管理员处理"
      }
    }
    return await nestJSAPI.post("/api/remittance/approve", args)
  }
}
```

### 3.3 工具命名规范

按项目命名空间前缀：`{projectId}_{toolName}`，避免多项目工具名冲突。
- SalesHub: `saleshub_query_orders`, `saleshub_approve_remittance`
- HR: `hr_query_leaves`, `hr_approve_leave`

### 3.4 动态工具注入

遵循 Anthropic 原则：**5 个聚焦工具 > 20 个工具**。不把项目所有工具一次性塞给 LLM。

```ts
// Prompt Engine 根据意图选择工具子集
buildSystemPrompt({ context, messages }) {
  const intent = classifyIntent(messages)
  const activeTools = intent === "sales_overview"
    ? [querySalesOverviewTool, queryTopCustomersTool]
    : intent === "order_detail"
    ? [queryOrdersTool, queryCustomerDetailTool]
    : allTools  // fallback
  // activeTools 传给 LLM
}
```

---

## 四、权限模型

### 4.1 模型权限意识（软约束）

通过 `useAgentContext` 注入 LLM 可读上下文，让模型知道自己能做什么：

```ts
// 项目前端层
useAgentContext({
  description: "当前用户角色与权限范围",
  value: JSON.stringify({
    role: user.role,
    name: user.name,
    scope: permissions.modules,
    constraints: permissions.constraints
  })
})
```

`buildSystemPrompt` 中使用 `resolveContext` 返回的同一份 context 构建 prompt 中的权限指令。

### 4.2 工具权限校验（硬约束）

每个工具的 execute 内部自行校验。不设统一 RBAC 引擎。工具拒绝时返回结构化错误。

### 4.3 两层配合的效果

- 模型有权限意识 → 减少无效工具调用，不浪费 token
- 工具有权限校验 → 即使模型判断失误，也不会执行越权操作
- 返回结构化错误 → 模型能理解原因并给用户有意义的回复

---

## 五、Agent 执行模型

### 5.1 默认：Hermes 模式（function calling）

大部分查询是单步或少量步骤，LLM 自主决策：

```ts
// 基于 CopilotKit BuiltInAgent 的 factory 模式
new BuiltInAgent({
  type: "aisdk",
  factory: ({ input, abortSignal }) => {
    const messages = convertMessages(input.messages)
    const tools = convertToolsToVercelAITools(config.tools)
    const systemPrompt = config.buildSystemPrompt(...)

    return streamText({
      model: wrappedModel,
      system: systemPrompt,
      messages,
      tools,
      stopWhen: ({ steps }) => shouldStop(steps),  // 项目自定义停止条件
      abortSignal,
    })
  }
})
```

适用场景：查订单、搜客户、销售概览、知识库问答等。

### 5.2 进阶：Harness 模式（DAG 编排）

复杂多步任务通过自定义 `DAGAgent` 实现，继承 AG-UI 的 `AbstractAgent`：

```ts
// DAGAgent 实现 AbstractAgent 的 run() 方法
class DAGAgent extends AbstractAgent {
  async run(input: RunAgentInput): Observable<BaseEvent> {
    const state = createInitialState(input)

    for (const step of this.dag.steps) {
      // 每步发射 STEP_STARTED 事件
      yield { type: "STEP_STARTED", stepId: step.id }

      if (step.type === "llm") {
        // LLM 步骤：调模型，流式输出
        const response = await streamText({ ... })
        yield* convertToAGUIEvents(response)
      } else if (step.type === "tool") {
        // 工具步骤：确定性执行
        const result = await step.tool.execute(state, context)
        yield { type: "TOOL_CALL_RESULT", content: JSON.stringify(result) }
      } else if (step.type === "condition") {
        // 条件路由：代码决定下一步
        const nextStep = step.evaluate(state)
        // 跳转...
      }

      // checkpoint 持久化
      await this.checkpointer.save(state)

      yield { type: "STEP_FINISHED", stepId: step.id }
    }
  }
}
```

适用场景：月报生成（收集→分析→图表→格式化）、多步审批流、复合数据处理。

### 5.3 选择策略

```
简单查询 (1-2 步)     → Hermes 模式，BuiltInAgent
复杂任务 (3+ 步，有分支) → Harness 模式，DAGAgent
```

遵循 Anthropic 简单性层级：从 Hermes 开始，有测量证据（模型频繁犯错、需要多步编排）时才引入 DAG。

---

## 六、Prompt Engine

### 6.1 动态组装

craft-advisor 验证过的模式：按意图和阶段动态拼 system prompt，而非一个静态大 prompt。

```ts
buildSystemPrompt({ context, messages }) {
  const intent = classifyIntent(messages)

  // 始终注入
  const base = `
    你是${context.name}，${context.role}角色。
    权限范围: ${context.scope.join('、')}
    限制: ${context.constraints.map(c => `不可${c}`).join('；')}
  `

  // 按意图注入域知识
  const domain = {
    "sales": SALES_DOMAIN_PROMPT,
    "order": ORDER_DOMAIN_PROMPT,
    "customer": CUSTOMER_DOMAIN_PROMPT,
    "remittance": REMITTANCE_DOMAIN_PROMPT,
  }[intent] ?? ""

  return [base, domain].join('\n\n')
}
```

### 6.2 意图分类

简单关键词匹配即可（craft-advisor 已验证此方案可行），不需要 LLM 做分类：

```ts
function classifyIntent(messages: Message[]): string {
  const lastUserMsg = messages.filter(m => m.role === "user").pop()
  if (!lastUserMsg) return "general"

  const text = typeof lastUserMsg.content === "string"
    ? lastUserMsg.content : ""

  if (/销售|业绩|目标|排名/.test(text)) return "sales"
  if (/订单|出货|交期/.test(text)) return "order"
  if (/客户|联系人|拜访/.test(text)) return "customer"
  if (/汇款|收款|对账/.test(text)) return "remittance"
  return "general"
}
```

---

## 七、会话持久化

### 7.1 替代 InMemoryAgentRunner

CopilotKit 默认的 `InMemoryAgentRunner` 把事件存在内存。生产环境需要持久化以支持：
- `connect` 端点恢复历史对话
- 服务重启不丢失对话
- 多实例部署（负载均衡）

实现 `DatabaseAgentRunner`：

```ts
class DatabaseAgentRunner extends AgentRunner {
  async run({ threadId, agent, input }) {
    // 1. 从数据库加载历史事件
    const history = await this.eventStore.getEvents(threadId)
    // 2. 在历史基础上继续执行
    // 3. 每个事件持久化到数据库
    // 4. connect 端点从数据库加载并发送
  }
}
```

### 7.2 存储方案

- **events 表**：存储 AG-UI 事件（追加写入，不可变）
- **threads 表**：存储线程元数据（agentId, userId, createdAt, title）
- **当前消息状态**：从 events 重建，不单独存储（event sourcing）

替代现有的 NestJS `/api/internal/chats/*` 端点和 Python agent 的回写逻辑。中台自带存储，NestJS 不再承担对话持久化职责。

### 7.3 前端恢复历史

前端调 `agent.connect()` → Runtime 从数据库加载历史 → 通过 AG-UI 事件流发送到前端。不需要 copilotkit-vue 的 `initialMessages` hack。

---

## 八、前端 SDK（copilotkit-vue npm 版本）

### 8.1 使用 npm 版本，不 fork

基于我们的决定，使用官方 npm 版本，在自己的代码中实现需要的功能。

### 8.2 替代 fork 功能的方案

| fork 功能 | 替代方案 |
|-----------|---------|
| `initialMessages` 恢复历史 | 中台 DatabaseAgentRunner + AG-UI `connect` 端点 |
| `messages-change` 事件 | 直接 `watch(messages)` —— `useCopilotChat` 返回的 messages 是 shallowRef |
| `regenerate()` 方法 | 自实现：删尾部消息 → `sendMessage` |

### 8.3 Render Tool 注册

每个项目注册自己的渲染组件，通过 `agentId` 隔离：

```ts
// SalesHub 项目前端
useRenderTool({
  name: "saleshub_query_sales_overview",
  render: (input) => h(DataCard, { data: input.result }),
})

useRenderTool({
  name: "saleshub_query_orders",
  render: (input) => h(DataTable, { columns: orderColumns, data: input.result }),
})
```

---

## 九、NestJS 角色变化

中台化后 NestJS 职责变薄：

| 职责 | 现在 | 中台化后 |
|------|------|---------|
| 业务 API | 不变 | 不变 |
| AI 代理 | Python agent + `/ai` 反代 | 移除，由中台 Runtime 承担 |
| 对话持久化 | `/api/internal/chats/*` | 移除，由中台自带存储 |
| 认证 | JWT + AuthMiddleware | 不变（中台信任传入的 JWT） |
| 反代入口 | 前端 SPA + `/ai` 反代 | 前端 SPA，`/ai` 反代指向前台 Runtime |

NestJS 成为纯业务 API 层。中台 Runtime 可以独立部署（作为单独服务），也可以作为 NestJS 的中间件嵌入。

---

## 十、项目结构

```
agent-platform/                      # 中台核心（新项目）
├── packages/
│   ├── runtime/                     # CopilotKit Runtime 扩展
│   │   ├── src/
│   │   │   ├── agent-runner/        # DatabaseAgentRunner
│   │   │   │   ├── database-runner.ts
│   │   │   │   └── event-store.ts
│   │   │   ├── dag/                 # DAGAgent (进阶)
│   │   │   │   ├── dag-agent.ts     # AbstractAgent 实现
│   │   │   │   ├── dag-executor.ts
│   │   │   │   └── checkpoint.ts
│   │   │   ├── middleware/           # 中间件管道
│   │   │   │   ├── auth.ts          # JWT 解析
│   │   │   │   ├── prompt-engine.ts # 动态 prompt 组装
│   │   │   │   └── tool-injector.ts # 按意图注入工具子集
│   │   │   ├── tools/               # 工具注册中心
│   │   │   │   ├── registry.ts      # ToolRegistry
│   │   │   │   └── types.ts
│   │   │   ├── agent-config/        # AgentConfig 接口
│   │   │   │   ├── types.ts
│   │   │   │   └── router.ts        # agentId → AgentConfig 路由
│   │   │   └── server.ts            # 入口 (CopilotRuntime + 扩展)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── database/                    # 持久化层
│       ├── migrations/
│       ├── event-store.ts
│       └── thread-store.ts
│
├── projects/                         # 项目适配层
│   ├── saleshub/                    # SalesHub 适配
│   │   ├── agent-config.ts          # AgentConfig 实现
│   │   ├── tools/                   # Server Tool 定义
│   │   │   ├── orders.ts
│   │   │   ├── customers.ts
│   │   │   ├── sales-analytics.ts
│   │   │   ├── remittance.ts
│   │   │   └── database-cognition.ts
│   │   ├── prompts/                 # Prompt 模板
│   │   │   ├── base.ts
│   │   │   ├── sales-domain.ts
│   │   │   ├── order-domain.ts
│   │   │   └── remittance-domain.ts
│   │   └── index.ts                 # 注册入口
│   │
│   └── hr/                          # 未来 HR 系统适配（结构同上）
│       ├── agent-config.ts
│       ├── tools/
│       ├── prompts/
│       └── index.ts
│
├── ocr-service/                     # OCR 独立微服务（保留 Python）
│   ├── main.py
│   ├── src/
│   │   └── ocr_processor.py         # 从 Python agent 中抽取
│   └── requirements.txt
│
├── package.json
├── ecosystem.config.js               # PM2 配置
└── .env
```

---

## 十一、实施阶段

### Phase 1：最小可用 Runtime（核心，优先）

目标：跑通一个 Hermes 模式的简单查询，验证 AG-UI 协议端到端。

1. 初始化 `agent-platform/` 项目（monorepo 结构）
2. 实现基于 CopilotKit Runtime 的 server，注册 BuiltInAgent
3. 实现 AgentConfig 接口和路由机制
4. 实现 SalesHub 适配层（3-5 个核心工具 + 1 个 prompt 模板）
5. 实现认证中间件（JWT 解析，透传 context）
6. 实现工具注册中心（ToolRegistry）
7. 前端接入 copilotkit-vue npm 版 + useRenderTool 注册渲染组件
8. 验证端到端：前端发送消息 → Runtime 处理 → 工具执行 → 渲染组件展示

### Phase 2：持久化与 Prompt Engine

目标：对话可恢复，prompt 按意图动态组装。

1. 实现 DatabaseAgentRunner（替代 InMemory）
2. 实现 event store + thread store（SQLite 或 PostgreSQL）
3. 实现 `connect` 端点，前端恢复历史对话
4. 实现 Prompt Engine（意图分类 + 动态 prompt 组装）
5. 实现 resolveContext（JWT → 业务上下文）
6. 实现工具权限校验（工具内部 + 结构化错误返回）
7. 扩展 SalesHub 工具集（覆盖现有 Python agent 的 17 个 API）

### Phase 3：高级能力

目标：复杂任务编排，OCR 集成。

1. 实现 DAGAgent（继承 AbstractAgent）
2. 实现 checkpoint 持久化
3. 抽取 OCR 为独立微服务，作为 Server Tool 接入
4. 中间件管道完善（日志、审计、token 计费）
5. `stopWhen` / `interrupt` 机制适配 FormWizard 场景

### Phase 4：多项目与部署

目标：验证可扩展性，生产部署。

1. HR 系统适配层（验证多项目能力）
2. AgentConfig 动态加载（不需要重启即可注册新项目）
3. PM2 / Docker 部署配置
4. 性能测试和优化
5. 从 Python agent 迁移（灰度切换）

---

## 十二、验证方案

### 端到端验证（每个 Phase 完成后）

1. **启动 Runtime**：`node server.ts`，确认 CopilotKit Runtime 健康
2. **前端连接**：Vue 项目配置 `runtimeUrl`，确认 AG-UI SSE 连接建立
3. **简单查询测试**：发送 "查一下最近的订单" → 确认工具被调用 → 确认渲染组件展示数据
4. **权限测试**：以 salesperson 角色发送 "审核一下这笔汇款" → 确认模型回复无权限
5. **历史恢复测试**：刷新页面 → 确认 connect 端点恢复对话
6. **流式输出测试**：确认文字流式显示，工具调用有进度指示
7. **多项目隔离测试**：不同 agentId 的工具和渲染组件互不干扰

### 迁移验证

1. 逐个对比 Python agent 的工具 → 确认新工具返回等价数据
2. 对比 ChatWithAgent.vue 的交互流程 → 确认新方案的 UX 等价或更优
3. 确认 NestJS `/api/internal/chats/*` 端点可以安全移除
