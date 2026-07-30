// 给 ai_harness_db 的表/字段加 MSSQL 注释（extended property MS_Description）。
// 让 SSMS / information_schema / AI 查库时都能看到中文业务注释（Prisma 的 /// 注释不进 DB，故单独写）。
// 幂等：先 drop（忽略"不存在"）再 add，可反复跑。注释文案在此维护（单一来源）。
// 跑：npx tsx scripts/apply-comments.ts  （或 npm run db:comment）
import { prisma, closeHarnessPrisma } from "../src/persistence/prisma.js";

const SPEC: { table: string; comment: string; columns: Record<string, string> }[] = [
  {
    table: "threads",
    comment:
      "会话线程主表。一次连续对话的元数据；事件/审计/artifact/摘要都以 thread_id 外键挂此，删线程级联清空。",
    columns: {
      id: "线程唯一标识（通常 UUID）。其余表以 thread_id 关联本字段。",
      agent_id: "所属 agent（项目 agentId，如 starlink_factory / freight_inquiry / db_demo）。",
      created_by: "创建人 userId，可空。",
      title: "线程标题（预留，目前未填）。",
      archived: "是否归档（软删除标记）。",
      created_at: "创建时间（UTC）。",
      updated_at: "最后更新时间（Prisma 自动维护）。",
    },
  },
  {
    table: "agent_events",
    comment:
      "AG-UI 事件流（append-only）。一次 run 产生的全部事件：消息增量/工具调用/状态快照等。connect 重放与历史回放的数据源，按 id 升序还原对话时序。",
    columns: {
      id: "自增主键。同线程内 id 升序即事件发生顺序，是重放排序依据。",
      thread_id: "所属线程，外键→threads.id（删线程级联）。",
      run_id: "产生本事件的 run 标识。不建外键（审计晚于事件落库，时序不允）。",
      agent_id: "产生本事件的 agent。",
      event_type:
        "AG-UI 事件类型，如 TEXT_MESSAGE_CONTENT / TOOL_CALL / TOOL_RESULT / RUN_STARTED / RUN_FINISHED / STATE_SNAPSHOT。",
      payload:
        "事件完整 JSON（整个 BaseEvent 序列化）。sqlserver 无 Json 类型故存文本，读取时 JSON.parse 还原。",
      created_at: "落库时间（UTC）。",
    },
  },
  {
    table: "agent_runs",
    comment:
      "运行审计。每次 run 的执行记录：步数/token/耗时/状态/模型/意图，用于监控大盘与排障。",
    columns: {
      id: "自增主键（id 倒序=最新优先）。",
      thread_id: "所属线程，外键→threads.id（删线程级联）。",
      run_id: "本次 run 的唯一标识（UUID）。",
      agent_id: "执行的 agent。",
      user_id: "发起人 userId，可空。",
      steps: "本次 run 的模型步数（工具循环轮次）。",
      prompt_tokens: "输入 token 数（模型返回；部分模型不返则 null）。",
      completion_tokens: "输出 token 数（可空）。",
      duration_ms: "本次 run 耗时（毫秒）。",
      finish_reason: "结束原因：stop=正常完成 / tool-calls=调工具继续 / error 等。",
      model: "使用的模型（如 glm-5.2 / deepseek-chat）。",
      intent: "意图分类（Hermes 模式透传；DAG 模式为 'dag'）。",
      status: "运行状态：success / error。",
      created_at: "记录时间（UTC）。",
    },
  },
  {
    table: "artifacts",
    comment:
      "工具结果外置。大块工具返回值按 ref 存储，模型上下文只带 ref+summary，需要完整数据时 getArtifact(ref) 取回。",
    columns: {
      ref: "工具结果全局唯一引用，格式 art-<base36时间>-<序号>。getArtifact 据此取回。",
      thread_id: "所属线程（可空，外键→threads.id）。",
      run_id: "产生该结果的 run（可空；不建外键）。",
      tool_name: "产生该结果的工具名。",
      args: "工具入参 JSON（可空）。",
      result: "工具完整返回值 JSON（可能 KB~MB）。模型上下文只放 summary，需要时按 ref 取本字段。",
      summary: "结果摘要（从 result 提取的关键文本，截断 1000 字；进入模型上下文的精简结论）。",
      created_at: "产生时间（UTC）。",
    },
  },
  {
    table: "thread_summary",
    comment:
      "线程滚动摘要。每线程一段事实摘要（run 结束滚动覆写），下次 run 注入 system 作为延续上下文。",
    columns: {
      thread_id: "所属线程，主键+外键→threads.id（一对一，删线程级联）。",
      summary: "摘要全文（单段：已做/关键数据/结论/约束；每次 run 结束覆写）。",
      updated_at: "最后滚动时间。",
    },
  },
];

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

async function setTableComment(table: string, comment: string): Promise<void> {
  await prisma
    .$executeRawUnsafe(
      `EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA', N'dbo', N'TABLE', N'${table}'`
    )
    .catch(() => {});
  await prisma.$executeRawUnsafe(
    `EXEC sp_addextendedproperty N'MS_Description', N'${esc(comment)}', N'SCHEMA', N'dbo', N'TABLE', N'${table}'`
  );
}

async function setColumnComment(table: string, col: string, comment: string): Promise<void> {
  await prisma
    .$executeRawUnsafe(
      `EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA', N'dbo', N'TABLE', N'${table}', N'COLUMN', N'${col}'`
    )
    .catch(() => {});
  await prisma.$executeRawUnsafe(
    `EXEC sp_addextendedproperty N'MS_Description', N'${esc(comment)}', N'SCHEMA', N'dbo', N'TABLE', N'${table}', N'COLUMN', N'${col}'`
  );
}

let tableCount = 0;
let colCount = 0;
for (const spec of SPEC) {
  await setTableComment(spec.table, spec.comment);
  tableCount++;
  for (const [col, c] of Object.entries(spec.columns)) {
    await setColumnComment(spec.table, col, c);
    colCount++;
  }
  console.log(`✓ ${spec.table} (${Object.keys(spec.columns).length} cols)`);
}
console.log(`\n已应用：${tableCount} 表注释 + ${colCount} 列注释`);

// 验证：回读 DB 里的 MS_Description
const rows = await prisma.$queryRaw<
  { level: string; table_name: string; column_name: string | null; comment: string }[]
>`
  SELECT
    CASE WHEN ep.minor_id = 0 THEN 'TABLE' ELSE 'COLUMN' END AS level,
    t.name AS table_name,
    c.name AS column_name,
    CAST(ep.value AS NVARCHAR(MAX)) AS comment
  FROM sys.extended_properties ep
  JOIN sys.tables t ON t.object_id = ep.major_id
  LEFT JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
  WHERE ep.name = 'MS_Description' AND ep.class = 1
  ORDER BY t.name, ep.minor_id
`;
console.log(`验证：DB 现有 ${rows.length} 条 MS_Description`);
console.log("表注释：");
for (const r of rows.filter((x) => x.level === "TABLE")) {
  console.log(`  ${r.table_name}: ${r.comment}`);
}

await closeHarnessPrisma();
