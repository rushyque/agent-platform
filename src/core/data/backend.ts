// 数据查询能力 —— 「后端驱动」抽象（适配器契约）。
// 中台只负责三件事：list_tables / describe_table / run_sql / sample_rows 的编排、
// guardSQL 只读守卫、结果的标准化。真正连哪个库、怎么鉴权，由接入方实现本接口，
// 在 AgentConfig.database 显式注入（平台 core 不耦合任何具体数据库）。
//
// 平台附赠一个 MSSQL 驱动（见 backends/mssql.ts），接入方可直接复用，也可自实现
// （例如包装自己的只读查询网关），从而把"通用查询能力"适配到各自的权限体系。

export interface ColumnSchema {
  name: string;
  dataType: string; // 物理类型，如 "nvarchar(50)" / "int"
  nullable: boolean;
  description?: string; // 业务名/注释（语义层）
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[]; // listTables 概览时可空
  rowCount?: number; // 行数（帮模型判断是否需 LIMIT、是否大表）
  description?: string; // 表注释
}

export interface QueryResult {
  columns: string[];
  // 数据库行结构由接入方/表决定，中台不假设其形状；消费方在转读时再收窄。
  rows: unknown[][];
  truncated?: boolean; // 是否被行数上限截断
}

/** 只读数据查询后端契约。接入方实现并注入，平台据此驱动通用查询原语。 */
export interface DatabaseBackend {
  /** 列出业务表概览（表名 + 行数 + 注释；不拉列，省 token）。 */
  listTables(): Promise<TableSchema[]>;
  /** 某张表的列定义。 */
  describeTable(tableName: string): Promise<TableSchema>;
  /** 抽样若干行，帮模型理解字段语义与真实取值。 */
  sampleRows(tableName: string, limit?: number): Promise<QueryResult>;
  /** 执行【只读】SQL（guardSQL 已拦截写操作）。limit 为行数兜底上限。 */
  executeQuery(sql: string, limit?: number): Promise<QueryResult>;
}
