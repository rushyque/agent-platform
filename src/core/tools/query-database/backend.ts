// DatabaseBackend —— NL→SQL 工具的「后端驱动」抽象。
// 中台只负责：选表 → 生成 SQL → guardSQL 校验 → 自纠 → trace；
// schema 获取与 SQL 执行由后端实现（中台 core 不耦合具体 DB）。
//
// 中台附赠 createMssqlBackend 默认适配器（见 ../backends/mssql.ts，复用 persistence/db.ts
// 的连接池，连 ai_platform_db 开箱即用）。项目也可自实现（调自己的后端端点），
// 在 AgentConfig.database 提供。

export interface ColumnSchema {
  name: string;
  dataType: string; // 物理类型，如 "nvarchar(50)" / "int"
  nullable: boolean;
  description?: string; // 业务名/注释（语义层补；本轮预留）
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[]; // listTables 概览时可空
  rowCount?: number; // 表行数（帮模型判断是否需 LIMIT、是否大表）
  description?: string; // 表注释
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  truncated?: boolean; // 是否被行数上限截断
}

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
