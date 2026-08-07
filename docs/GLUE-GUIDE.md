# 中台接入指南：如何为已有系统编写胶水层

> 本文档面向"已有成熟业务系统，想接入 AI 中台"的开发者。
> 你不需要重写任何业务逻辑，只需要写一层薄薄的适配代码——我们叫它"胶水"。

---

## 1. 先理解一件事

你的系统现在是这样的：

前端页面 --> 你的后端 API --> Service 层 --> 数据库

接入中台后，多了一条并行的路：

AI Agent --> 中台工具(execute) --> 你的后端 API --> Service 层 --> 数据库

两条路到的是同一个 Service 层，改的是同一份数据库。
AI 没有绕过你的系统，它只是多了一个"会说话的操作员"，通过你的 API 去干活。

所谓胶水，就是一组适配函数：每个函数把一个业务操作包装成 AI 能调用的工具。
函数体里干的事情就是"调你现有的 API，把结果翻译成 AI 能理解的结构化返回"。

不碰数据库结构，不改现有代码，不加新的业务逻辑。

---

## 2. 动手前要准备的东西

写胶水之前，你需要两张清单。不用很正式，白板上画就行。

### 清单 A：业务流程图

把你的业务从开始到结束拆成操作节点，画成一张流程图。
以销售系统为例：

报价 --> 提交审批 --> 审批 --> 确认订单 --> 仓库发货 --> 回款确认

这张图决定了你要写多少个工具。流程图上每一个可操作节点 = 一个工具。
如果某个节点有分支（审批通过/驳回），在工具的返回值里处理，不要拆成两个工具。

### 清单 B：API 对应表

每个操作节点，找到你现有系统里对应的 API 端点：

| 流程节点   | 工具名                  | 你的 API                          | 方法 |
|-----------|------------------------|-----------------------------------|------|
| 创建报价   | sales_create_quote     | POST /api/quotes                  | 写   |
| 提交审批   | sales_submit_quote     | POST /api/quotes/:id/submit       | 写   |
| 审批      | sales_review_quote     | POST /api/quotes/:id/review       | 写   |
| 确认订单   | sales_confirm_order    | POST /api/orders/from-quote       | 写   |
| 发货      | sales_ship_order       | POST /api/orders/:id/ship         | 写   |
| 回款      | sales_record_payment   | POST /api/orders/:id/payment      | 写   |
| 查订单列表 | sales_list_orders      | GET /api/orders                   | 读   |
| 查客户     | sales_list_customers   | GET /api/customers                | 读   |
| 查库存     | sales_check_inventory  | GET /api/inventory/:productId     | 读   |

这张表完成后，你就知道要写几个函数、每个函数里 fetch 什么地址了。

如果某个操作没有 API（只有数据库），有两种选择：
- 临时加一个 API（推荐，解耦最干净）
- 胶水里直连数据库（快速但不推荐长期）

---

## 3. 胶水函数的结构

每个胶水函数就是一个 ToolDefinition 对象（参考 src/types/agent-config.ts）：

  name: string           工具名，全局唯一，用 项目前缀_动词名词
  description: string    给 AI 看的说明书，越详细 AI 越会用
  parameters: z.ZodTypeAny  参数 schema，用 zod 定义
  execute: (args, context) => Promise<any>  执行逻辑
  readonly?: boolean     可选：标记只读工具，结果不被上下文压缩折叠

一个典型的胶水函数长这样：

export const createQuoteTool: ToolDefinition = {
  name: "sales_create_quote",
  description: "为客户创建报价单。需要客户ID和产品明细。创建后状态为草稿，需调 sales_submit_quote 提交审批。",
  parameters: z.object({
    customerId: z.string().describe("客户 ID"),
    items: z.array(z.object({
      productId: z.string().describe("产品 ID"),
      quantity: z.number().int().min(1).describe("数量"),
      unitPrice: z.number().min(0).describe("单价"),
    })).describe("报价明细"),
  }),
  execute: async (args, context) => {
    // 这里就是胶水的核心：调你的 API
    const resp = await fetch(BUSINESS_API + "/api/quotes", {
      method: "POST",
      headers: {
        "Authorization": context.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customerId: args.customerId,
        items: args.items,
        repId: context.userId,
      }),
    });
    const result = await resp.json();
    return {
      ok: resp.ok,
      message: resp.ok ? "报价单 " + result.quoteNo + " 已创建" : result.error || "创建失败",
      hint: resp.ok ? "下一步：sales_submit_quote 提交审批" : undefined,
    };
  },
};

每个部分的作用：

name：全局唯一，用 前缀_操作 命名（sales_create_quote、hr_query_employee）。
不要用泛化名字（create、query），AI 在多 agent 场景下会混淆。

description：这是 AI 的说明书。写得越清楚，AI 调得越准。
要点：这个工具干什么、什么时候该用、用完后状态变成什么。

parameters：用 zod 定义，每个字段都写 .describe()。
AI 根据 schema 决定传什么参数。描述越清楚，参数填得越准。

execute：胶水的核心。拿 args（AI 填的参数）和 context（中台注入的身份信息），
调你的业务 API，把结果翻译成结构化返回。不写业务校验逻辑。

readonly：查询类工具标 readonly: true。中台不会把它的结果折叠压缩，
AI 随时能回看完整数据。写操作工具不标。

---

## 4. 三种胶水写法

根据你现有系统的架构，胶水的 execute 里调的东西不同。

### 写法 A：调 REST API（最常见）

你的系统已有 HTTP API，胶水直接 fetch：

  execute: async (args, context) => {
    const resp = await fetch(BUSINESS_API + "/api/orders", {
      method: "POST",
      headers: { "Authorization": context.token, "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, repId: context.userId }),
    });
    const data = await resp.json();
    return { ok: resp.ok, message: resp.ok ? "成功" : data.error, data };
  },

context.token 是中台从 JWT 解析出来的原始 token，透传给你的 API 做鉴权。
这样 AI 的操作和你前端用户的操作走的是同一套权限控制。

### 写法 B：直连数据库（快速但有限制）

如果你的系统没有 API，或者 API 很重，可以直接查库。
中台已经有 createMssqlBackend，在 AgentConfig 里配 database 字段后，
context.database 自动可用：

  execute: async (args, context) => {
    const rows = await context.database.query(
      "SELECT * FROM orders WHERE rep_id = @userId AND status = @status",
      { userId: context.userId, status: args.status }
    );
    return { count: rows.length, orders: rows };
  },

注意：直连数据库跳过了你的 Service 层校验逻辑。
如果业务有复杂校验（库存检查、信用额度），建议走写法 A 或 C。

### 写法 C：调 Service 层（同进程，最干净）

如果你的胶水和业务系统跑在同一个 Node 进程里，直接调 Service 函数：

  import { QuoteService } from "../../your-system/services/quote.js";
  execute: async (args, context) => {
    const quote = await QuoteService.create({
      customerId: args.customerId,
      items: args.items,
      userId: context.userId,
    });
    return { ok: true, message: "报价单 " + quote.quoteNo + " 已创建" };
  },

这样所有校验逻辑、事务、事件触发都完整保留，AI 等于一个"没有前端界面的用户"。
询价系统的 engine.ts 就是这种模式的变体。

### 三种写法的选择

| 场景                       | 推荐写法 |
|---------------------------|---------|
| 系统已有 REST API          | A       |
| 系统只有数据库，API 难加    | B       |
| 胶水和系统同进程            | C       |
| 新系统从零搭建             | C       |
| 要复用现有权限/中间件       | A       |

不管选哪种，工具的外层结构完全一样。
AI 不关心你 execute 里面干了什么，它只看 name 知道能调什么、看 parameters 知道传什么、看返回知道结果。

---

## 5. 让 AI 跑通全流程的关键：hint

这是整篇文档里最重要的一个概念。

AI 能不能"自由跑通整个流程"，不取决于你写了多少工具，而取决于每个工具的返回值有没有告诉 AI 下一步该干什么。

看询价系统的胶水代码（src/projects/freight-inquiry/tools/inquiry.ts），每个工具返回里都带 hint：

  return {
    ok: true,
    message: "报价单 Q-0001 已创建",
    hint: "下一步：sales_submit_quote 提交审批",
  };

AI 看到 hint 后就知道："哦，创建完了该提交审批了，我调 sales_submit_quote。"
不需要你写一个巨大的编排函数，AI 自己会顺着 hint 一步步走。

### 分支流程的 hint

审批有通过和驳回两条路，hint 要分别提示：

  execute: async (args, context) => {
    const result = await callYourApi(args);
    return {
      ok: true,
      message: result.decision === "approve" ? "审批通过" : "审批驳回",
      hint: result.decision === "approve"
        ? "下一步：sales_confirm_order 确认订单"
        : "下一步：sales_create_quote 重新报价",
    };
  },

### 查询工具的 hint

查询工具不改变状态，但可以提示"当前整体在什么阶段、还差什么"。
如果你的流程很复杂，建议写一个 overview 工具，让 AI 拿不准状态时调一次就能看到全局。

---

## 6. 查询工具 vs 操作工具

查询工具（只读）：调 GET API 或 SELECT 查询，不改变任何状态。
标 readonly: true，中台保证完整返回始终保留在上下文里，不被压缩。
AI 可以随时回看，不用重复调用。

操作工具（写）：调 POST/PUT/DELETE 或 INSERT/UPDATE，改变业务状态。
不标 readonly。返回里必须带 ok/message/hint。

一个系统的胶水里，查询工具通常占一半以上。
AI 在执行操作前需要先查现状，查完才敢动手。

---

## 7. 组合工具：让 AI 一句话跑完全流程

当你的流程跑通后，你会发现 AI 总是在重复固定组合。
这时候可以写一个组合工具，把多步压成一次调用。

工厂游戏的 runPipeline 就是最佳范例（src/projects/starlink-factory/tools/ops.ts）：
它在一个 execute 里依次调用 acceptInquiry、startDesign、scheduleJob、advanceShifts，
把整个生产流水线一口气跑完。

注意：组合工具是优化项，不是必选项。
先把每个操作写成独立工具，让 AI 自然地一步步调用。
跑通之后再根据观察到的使用模式，把高频组合封成一个工具。

---

## 8. 注册你的系统

胶水写完后，需要在两个地方注册。

### 8.1 写 AgentConfig

参考 src/projects/starlink-factory/agent-config.ts。
resolveContext 是中台每次请求时调的，从 JWT 里解析出 userId 和 token，
塞进 context，后续每个工具的 execute 都能拿到。

### 8.2 写 System Prompt

参考 src/projects/freight-inquiry/prompts.ts，告诉 AI "你是谁、能干什么、流程是什么"。
System prompt 里最重要的是两段：
1. 流程步骤：把工具按业务顺序列出来，AI 会自然地顺着这个顺序走。
2. 工作纪律：告诉 AI "必须调工具才能改状态，不许编造结果"。

### 8.3 注册到平台

在 src/projects/index.ts 里加 registerAgent(yourAgentConfig)。
完成后重启中台，/agent/your_agent/run 就能用了。
前端只需要把 ai-assistant.js 里的 AGENT 变量改成你的 agentId。

---

## 9. 文件组织

一个项目的胶水代码放在 src/projects/项目名/ 下：

  src/projects/sales/
    agent-config.ts      AgentConfig：身份解析 + 工具列表 + prompt
    prompts.ts           System Prompt 构建
    tools/
      index.ts           工具聚合导出
      orders.ts          订单相关工具
      customers.ts       客户相关工具
      inventory.ts       库存查询工具
      composite.ts       组合工具（可选，后期再加）

工具按业务领域分文件，而不是按"读/写"分。

---

## 10. 前端接入

前端不需要重写。复用 public/ai-assistant.js，只改一个变量：

  var AGENT = "sales_agent";

你的业务页面和 AI 助手面板可以并存：
- 业务页面照常工作（用户手动操作）
- AI 面板是并行的操作入口（用户用对话操作）
- 两者改的是同一份数据，互相能看到对方的操作结果

---

## 11. 验证清单

胶水写完后，按这个清单逐项验证：

工具层面：
- 每个流程节点的操作都有对应的工具
- 每个工具的 description 写清楚了"干什么 + 什么时候用"
- 每个写操作工具返回 ok / message / hint
- 查询工具标了 readonly: true
- 工具名带项目前缀（sales_xxx、hr_xxx）

流程层面：
- 用 AI 跑一遍完整流程，从头到尾不卡住
- 流程中途出错时，AI 能正确读取 ok:false 并转告用户
- 分支流程（审批驳回等）的 hint 指向正确
- AI 先查询再操作（不会无脑调写操作）

安全层面：
- 所有 API 调用都带了 context.token 做鉴权
- 数据查询按 userId 隔离（销售员只看到自己的数据）
- 不可逆操作有 confirm 工具做二次确认

中台层面：
- agentId 在 index.ts 注册了
- System Prompt 写了流程步骤和工作纪律
- 前端 AGENT 变量改对了

---

## 12. 常见问题

### AI 不调工具，自己编结果
原因：System Prompt 缺了"工作纪律"段落。
解决：明确告诉 AI "没调用工具 = 什么都没发生"。

### AI 调错工具或传错参数
原因：工具的 description 不够清楚。
解决：把 description 写得更详细，特别是"什么时候用"和"参数含义"。

### AI 跑到一半不知道下一步该干什么
原因：工具返回缺 hint。
解决：每个写操作的返回都加 hint 字段，明确告诉 AI 下一步调什么工具。

### 工具返回的数据太大，AI 上下文爆了
原因：返回了完整的数据库记录。
解决：在 execute 里做字段裁剪，只返回 AI 需要的。
中台也有 artifact 外置机制，但前端裁剪始终是第一道防线。

### 多个用户的数据混了
原因：execute 里没用 context.userId 做隔离。
解决：所有查询和操作都按 userId 过滤。

---

## 附：最小可运行模板

直接复制这个模板，改三处就能跑：

  import { z } from "zod";
  import type { AgentConfig } from "../../types/agent-config.js";

  const API = process.env.MY_SYSTEM_API || "http://localhost:3000";

  const myTool = {
    name: "mysys_query",
    description: "查询 XXX 数据",
    parameters: z.object({ keyword: z.string().describe("搜索关键词") }),
    readonly: true,
    execute: async (args, context) => {
      const resp = await fetch(API + "/api/data?q=" + args.keyword, {
        headers: { Authorization: context.token },
      });
      return await resp.json();
    },
  };

  export const myAgentConfig = {
    agentId: "my_agent",
    resolveContext: async ({ userId, token }) => ({ userId, token }),
    tools: [myTool],
    buildSystemPrompt: () => "你是 XXX 系统助手。通过工具查询和操作数据。",
  };

然后在 src/projects/index.ts 加注册，前端 ai-assistant.js 里 AGENT = "my_agent"。
启动中台，打开页面，就能和 AI 对话操作你的系统了。