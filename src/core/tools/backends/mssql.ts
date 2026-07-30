import { getPool, sql } from "../../../persistence/db.js";
import type {
  DatabaseBackend,
  TableSchema,
  QueryResult,
  ColumnSchema,
} from "../query-database/backend.js";

// 中台附赠的默认 MSSQL 适配器 —— 复用 persistence/db.ts 的连接池（连 ai_platform_db）。
// 项目在 AgentConfig.database 或 resolveContext 里 createMssqlBackend() 即开箱可用。

export interface MssqlBackendOptions {
  /** 白名单：只暴露这些表（大小写不敏感）。缺省=全部用户表。 */
  includeTables?: string[];
  /** 黑名单：排除敏感表。 */
  excludeTables?: string[];
  /** 抽样/查询默认行数上限。默认 50。 */
  defaultLimit?: number;
}

function norm(s: string): string {
  return (s ?? "").toLowerCase();
}

function toQueryResult(res: any, cap: number): QueryResult {
  const rs = (res?.recordset ?? []) as any[];
  const columns = rs.length > 0 ? Object.keys(rs[0]) : [];
  const rows = rs.map((r) => columns.map((c) => r[c]));
  return { columns, rows, truncated: rows.length >= cap };
}

export function createMssqlBackend(opts: MssqlBackendOptions = {}): DatabaseBackend {
  const defaultLimit = opts.defaultLimit ?? 50;
  const include = opts.includeTables?.map(norm);
  const exclude = opts.excludeTables?.map(norm);
  const allow = (name: string): boolean => {
    const n = norm(name);
    if (exclude?.includes(n)) return false;
    if (include && !include.includes(n)) return false;
    return true;
  };

  return {
    async listTables(): Promise<TableSchema[]> {
      const pool = await getPool();
      const res = await pool.request().query(`
        SELECT tbl.TABLE_NAME AS name,
               ISNULL((
                 SELECT SUM(ps.row_count)
                 FROM sys.dm_db_partition_stats ps
                 WHERE ps.object_id = OBJECT_ID(tbl.TABLE_SCHEMA + '.' + tbl.TABLE_NAME)
                   AND ps.index_id IN (0, 1)
               ), 0) AS row_count
        FROM INFORMATION_SCHEMA.TABLES tbl
        WHERE tbl.TABLE_TYPE = 'BASE TABLE'
        ORDER BY tbl.TABLE_NAME
      `);
      return (res.recordset as any[])
        .filter((r) => allow(r.name))
        .map((r) => ({ name: r.name, rowCount: Number(r.row_count) || 0, columns: [] }));
    },

    async describeTable(tableName: string): Promise<TableSchema> {
      const pool = await getPool();
      const res = await pool
        .request()
        .input("tn", sql.NVarChar, tableName)
        .query(`
          SELECT COLUMN_NAME AS name,
                 DATA_TYPE AS dt,
                 CHARACTER_MAXIMUM_LENGTH AS len,
                 NUMERIC_PRECISION AS prec,
                 IS_NULLABLE AS nullable
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @tn
          ORDER BY ORDINAL_POSITION
        `);
      const columns: ColumnSchema[] = (res.recordset as any[]).map((r) => {
        let dataType: string = r.dt;
        if (r.len != null) dataType += `(${r.len === -1 ? "MAX" : r.len})`;
        else if (r.prec != null) dataType += `(${r.prec})`;
        return { name: r.name, dataType, nullable: r.nullable === "YES" };
      });
      return { name: tableName, columns };
    },

    async sampleRows(tableName: string, limit?: number): Promise<QueryResult> {
      const safe = tableName.replace(/[^\w.\[\]]/g, "");
      const cap = limit ?? 5;
      const pool = await getPool();
      const res = await pool
        .request()
        .query(`SET ROWCOUNT ${cap}; SELECT * FROM [${safe}]; SET ROWCOUNT 0;`);
      return toQueryResult(res, cap);
    },

    async executeQuery(sqlText: string, limit?: number): Promise<QueryResult> {
      const cap = Math.min(limit ?? defaultLimit, 500);
      const pool = await getPool();
      // SET ROWCOUNT 兜底行数（即使模型漏写 TOP 也限流）；执行后复位，避免污染连接后续查询。
      const res = await pool
        .request()
        .query(`SET ROWCOUNT ${cap}; ${sqlText}; SET ROWCOUNT 0;`);
      return toQueryResult(res, cap);
    },
  };
}
