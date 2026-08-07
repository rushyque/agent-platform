import { getPool, sql } from "../../../persistence/db.js";
import type {
  DatabaseBackend,
  TableSchema,
  QueryResult,
  ColumnSchema,
} from "../query-database/backend.js";

// MSSQL adapter -- reads MS_Description (semantic annotations) via sys.extended_properties.
// listTables/describeTable now return business-level descriptions alongside column metadata,
// giving the model real "database literacy" instead of raw column names.

export interface MssqlBackendOptions {
  /** Whitelist: only expose these tables (case-insensitive). Default = all user tables. */
  includeTables?: string[];
  /** Blacklist: exclude sensitive tables. */
  excludeTables?: string[];
  /** Default row cap for sampling/queries. Default 50. */
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
               ), 0) AS row_count,
               CAST(ISNULL((
                 SELECT ep.value FROM sys.extended_properties ep
                 WHERE ep.major_id = OBJECT_ID(tbl.TABLE_SCHEMA + '.' + tbl.TABLE_NAME)
                   AND ep.minor_id = 0 AND ep.name = 'MS_Description'
               ), '') AS NVARCHAR(MAX)) AS tbl_comment
        FROM INFORMATION_SCHEMA.TABLES tbl
        WHERE tbl.TABLE_TYPE = 'BASE TABLE'
        ORDER BY tbl.TABLE_NAME
      `);
      return (res.recordset as any[])
        .filter((r) => allow(r.name))
        .map((r) => ({
          name: r.name,
          rowCount: Number(r.row_count) || 0,
          description: r.tbl_comment || undefined,
          columns: [],
        }));
    },

    async describeTable(tableName: string): Promise<TableSchema> {
      const pool = await getPool();
      const res = await pool
        .request()
        .input("tn", sql.NVarChar, tableName)
        .query(`
          SELECT c.COLUMN_NAME AS name,
                 c.DATA_TYPE AS dt,
                 c.CHARACTER_MAXIMUM_LENGTH AS len,
                 c.NUMERIC_PRECISION AS prec,
                 c.IS_NULLABLE AS nullable,
                 CAST(ISNULL((
                   SELECT ep.value FROM sys.extended_properties ep
                   WHERE ep.major_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
                     AND ep.minor_id = c.ORDINAL_POSITION
                     AND ep.name = 'MS_Description'
                 ), '') AS NVARCHAR(MAX)) AS col_comment,
                 CAST(ISNULL((
                   SELECT ep.value FROM sys.extended_properties ep
                   WHERE ep.major_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
                     AND ep.minor_id = 0
                     AND ep.name = 'MS_Description'
                 ), '') AS NVARCHAR(MAX)) AS tbl_comment
          FROM INFORMATION_SCHEMA.COLUMNS c
          WHERE c.TABLE_NAME = @tn
          ORDER BY c.ORDINAL_POSITION
        `);
      const rows = res.recordset as any[];
      if (rows.length === 0) return { name: tableName, columns: [] };
      const tableDesc = rows[0].tbl_comment || undefined;
      const columns: ColumnSchema[] = rows.map((r) => {
        let dataType: string = r.dt;
        if (r.len != null) dataType += `(${r.len === -1 ? "MAX" : r.len})`;
        else if (r.prec != null) dataType += `(${r.prec})`;
        return {
          name: r.name,
          dataType,
          nullable: r.nullable === "YES",
          description: r.col_comment || undefined,
        };
      });
      return { name: tableName, description: tableDesc, columns };
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
      const res = await pool
        .request()
        .query(`SET ROWCOUNT ${cap}; ${sqlText}; SET ROWCOUNT 0;`);
      return toQueryResult(res, cap);
    },
  };
}
