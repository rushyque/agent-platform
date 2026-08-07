# 交接记忆：AI Agent 中台项目

> 本文档是跨对话交接用，帮助新的对话快速理解项目全貌、已完成的工作和待办方向。
> 最后更新：2026-08-05
> （本轮更新：工具架构重构——Codex 原语化）

## 一、项目是什么

**AI Agent 中台**（`agent-platform`），位于 `D:\code\vue\agent-platform`。

用 CopilotKit Runtime + AG-UI 协议 + DeepSeek LLM，让 AI agent 通过工具调用来操作业务系统。
用户（老板/操作员）通过一个可拖动的对话弹窗（`ai-assistant.js`）与 agent 交互。
agent 调用工具执行操作，结果经 SSE 流式返回前端。

**核心价值**：业务系统不需要改造成 AI 原生的，只需要写一层薄薄的"胶水"（适配函数），
把已有 API 包装成 agent 可调用的工具，就能接入中台获得 AI 辅助能力。

### 真实业务系统（待接入）
- **SalesHub**（`D:\code\vue\saleshub`）：销售数据中心，Vue 3 + NestJS，MSSQL，JWT 鉴权，3 角色
- **人事系统**：细节未深入
- **询价系统**：已在中台有 freight-inquiry 项目（17 个工具）

## 二、技术架构速览

```
用户 ──浏览器── ai-assistant.js（接入件）
                      │
                      │ SSE (AG-UI)
                      ▼
              agent-platform 中台 (端口 9876)
              ├── CopilotRuntime（编排 agent 运行）
              ├── 工具管线：toAISDKTools 包装 → execute → artifact 外置
              ├── 上下文管理：压缩 / getArtifact 回取
              └── 项目适配层：每个业务系统一个 AgentConfig

agent-platform 不碰业务数据写操作。
引导/DOM 动作由前端执行，鉴权留在浏览器（用户已登录态）。
```

### 关键设计模式：UI 指令传递（不碰数据）

中台的交互工具（guide_user / present_choices / notify / open_link）后端是 no-op，
只返回 `{ui:{type,...}, hint}` 结构化指令。前端拦截 TOOL_CALL_RESULT，
按 `ui.type` 分发执行真正的 DOM 动作。这样：
- 写操作鉴权始终留在前端
- agent 做"指路人"而非"操盘手"
- 用户始终在决策回路中

## 三、关键文件地图

### 中台核心
- `src/server.ts` — HTTP 入口 + CopilotRuntime + agent 工厂 + 工具包装（toAISDKTools）
- `src/types/agent-config.ts` — AgentConfig / ToolDefinition 接口定义
- `src/config/settings.ts` — 环境配置（端口 9876, DeepSeek, MSSQL, JWT_SECRET）
- `src/core/middleware/auth.ts` — JWT 签发/验证（extractToken / verifyToken / signToken）
- `src/core/context/artifact-store.ts` — 工具结果外置存储（内存 LRU + Prisma DB）
- `src/core/agent-router.ts` — agent 注册表（resolveAgent / getAllAgentIds）
- `src/projects/index.ts` — 项目注册入口（registerAgent + registerProjectRoutes）

### 中台通用工具（src/core/tools/）
- `index.ts` — 导出 coreTools 对象（感知/记忆/人机/交互四组）
- `interact.ts` — **交互工具集**（guide_user / present_choices / notify / open_link）
- `observe-state.ts` — 运行态快照（需 context.getState 或 context.summarizeState）
- `query-database/` — NL->SQL 只读查询（需 context.database）
- `recall.ts` — 回看历史工具结果
- `notes.ts` — 线程便签（set_note / get_note）
- `now.ts` — 权威时间
- `confirm.ts` — 写操作前人确认

### 工厂项目（src/projects/starlink-factory/）
- `agent-config.ts` — AgentConfig（resolveContext 注入 domMap / getState / formatTime）
- `prompts.ts` — 厂长系统提示词
- `tools/` — 28 个业务工具 + 中台通用工具
- `game/` — 游戏引擎（state-store / engine / game-bus / types）
- `http.ts` — 项目 HTTP 路由（/game + dev-login + state API + SSE stream）

### 前端
- `public/game.html` — 单文件工厂游戏（727 行，零服务器依赖，localStorage 持久化）
- `public/ai-assistant.js` — 可拖动对话弹窗 + UI 指令分发器（统一处理所有交互工具）

### 文档
- `docs/GLUE-GUIDE.md` — 接入指南：如何为已有业务系统制作胶水层
- `docs/HANDOFF.md` — 本文档

## 四、中台 JWT 的作用（重要！）

中台 JWT 和业务系统 JWT 是**两套独立的东西**：

| | 中台 JWT | 业务系统 JWT（如 SalesHub）|
|---|---|---|
| 签发者 | dev-login / console mint-token | 业务系统 /auth/login |
| 密钥 | settings.JWT_SECRET | 业务系统自己的密钥 |
| 保护什么 | 中台 /agent/*/run、游戏存档 | 业务系统所有 API |
| 用途 | 会话隔离 + 身份识别 + 角色透传 | 鉴权 + 角色权限控制 |

**当前解决方案**：第一阶段只做"查询 + DOM 引导"，agent 不直接写数据。
因此认证问题几乎消失——写操作由前端发起，走业务系统原有鉴权链路，中台完全不碰业务 JWT。

## 五、已完成的工作

### 1. 单文件工厂游戏（game.html）
- 从中台 TypeScript 引擎移植为纯 JS 单文件，零服务器依赖
- localStorage 持久化，无 fetch/SSE/CopilotKit 依赖
- AI 对话由直接操作按钮替代

### 2. AI 助手接入件（ai-assistant.js）
- 可拖动浮动对话弹窗，中台不启动时游戏正常跑
- dev-login 认证、AG-UI SSE 流处理、Markdown 渲染、工具卡片
- 消息持久化到 localStorage

### 3. 中台通用交互工具集（interact.ts）
- guide_user：DOM 引导（滚动+高亮）
- present_choices：对话选项卡（点击自动回复）
- notify：页面通知 toast
- open_link：打开链接/路由跳转
- 统一 UI 指令分发器，前端不按工具名硬编码
- 字段命名避开 summarizeToolResult 优先字段，确保 JSON 完整传到前端

### 4.5 工具架构重构（Codex 原语化，本轮完成）
对比 Codex 的工具哲学（少而通用的能力原语），发现中台工具存在三个结构问题并已修复：
1. **NL→SQL 子 agent → 三原语**：删掉固定四阶段流水线，改为 list_tables / describe_table / run_sql 三个细粒度原语。模型自主探索库结构、自己写 SQL、自己看报错自己改。guardSQL 保留。mssql 适配器读 MS_Description 建立语义认知。
2. **业务工具流程步骤 → 资源原语**：freight-inquiry 17→4（inquiry/email/quote/decision）；starlink 22→4（factory_ops/order/production/workshop）。每个用 mode 参数分发，engine 逻辑不变。
3. **交互工具碎片 → show_ui**：guide_user/present_choices/notify/open_link 合并为一个 show_ui（mode 分发）。前端不受影响。
4. **语义注释链**：`scripts/annotate-business-tables.ts`（`npm run db:annotate`）给业务库写 MS_Description，describe_table 读出来给模型看。

### 4. 胶水接入指南（GLUE-GUIDE.md）
- "胶水"概念：薄适配函数，把已有 API 包装为 AI 工具
- 三种实现模式（REST fetch / 直连 DB / Service 导入）
- hint 模式：每个工具返回下一步引导

### 5. SalesHub 分析
- 已深入审查代码，识别 6 个关键差距
- 详见下文"待办"

## 六、待办与下一步

### SalesHub 接入的 6 个差距（已分析，未实现）
1. **认证桥接**：两套 JWT 需要打通。方案：前端透传 SalesHub JWT，中台 resolveContext 提取
2. **角色感知**：selectTools 钩子存在但未用。需按 context.role 过滤工具集
3. **数据裁剪**：SalesHub API 返回重数据，胶水需严格裁剪
4. **只读 vs 写入边界**：Phase 1 只读，Phase 2 写操作走 API（绝不直连 DB）
5. **已有聊天设施复用**：SalesHub 有 ChatService 但 SSE 格式不兼容 AG-UI
6. **ERP 双库感知**：金蝶 K/3 (05, 只读) -> 镜像库 (09)，有同步延迟

### 推荐的接入顺序
1. 认证桥接设计（前端透传 JWT，resolveContext 解析）
2. 角色感知工具选择（实现 selectTools）
3. SalesHub 胶水脚手架（src/projects/sales/）
   - Phase 1 只读：list_orders / order_detail / payment_alerts / analytics_chart
   - Phase 2 写入：fill_remit / approve_remit / create_visit_plan
4. 前端适配（SalesHub 的 aiService 或复用 ai-assistant.js）
5. ERP 延迟感知写入系统提示词

### 其他可能的优化方向
- 更多中台通用工具（如 fetch_url 通用 HTTP 工具、数据可视化卡片工具）
- 工具调用审计与回放（已有 run-store / event-store 基础）
- 多 agent 协作（DAG 模式已有基础）
- observe_state 支持更丰富的结构化状态

## 七、关键设计决策记录

1. **不摘 CopilotKit**：用户明确决定保留，目前没问题
2. **用 Codex 开源 agent？**：探索过，决定继续当前方案
3. **"胶水"隐喻**：用户喜欢这个词描述适配层，文档中统一使用
4. **游戏极致单文件**：用户要求 game.html 单文件独立运行，剥离所有 AI 中台关联
5. **agent 不直接写数据**：通过 DOM 引导让用户自己操作，更安全
6. **中台保持通用**：交互工具放 core 层而非项目层，一次做好所有项目受益
7. **字段命名技巧**：交互工具结果避开 summarizeToolResult 优先字段（trace/summary/message/error/detail/data），
8. **工具原语化**：参考 Codex，工具给"能做什么"不给"按什么步骤做"。数据访问三原语替代子 agent；业务工具按资源合并用 mode 分发；交互工具四合一。
9. **语义注释即认知**：MS_Description 是模型的"数据库认知层"，describe_table 读注释让模型理解列的业务含义。
   走 safeStringify 兜底确保完整 JSON 传递

## 八、开发与运行

```powershell
# 启动中台（监听 192.168.1.155:9876）
cd D:\code\vue\agent-platform
npx tsx src/server.ts   # 或 npm run dev (tsx watch)

# 访问工厂游戏
# http://192.168.1.155:9876/game

# 调试控制台
# http://192.168.1.155:9876/debug

# 观察控制台（SSE 实时流）
# http://192.168.1.155:9876/console

# TypeScript 编译检查
npx tsc --noEmit
```

### 环境
- Node.js + tsx（开发）/ node dist/（生产）
- DeepSeek API（settings 里 DEEPSEEK_API_KEY）
- MSSQL（ai_harness_db 状态库 + ai_platform_db ERP 库）
- Prisma ORM
- 端口 9876

## 九、用户偏好

- 中文沟通，中文 UI 和注释
- 代码文件保持 ASCII（中文只在注释/字符串里）
- 喜欢实际动手验证，不喜欢纯理论计划
- 重视"胶水"这个隐喻
- 希望中台像 Codex 一样有一系列通用工具
- 游戏要极致单文件，可脱离中台独立运行
