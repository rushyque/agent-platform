import sql, { type IConnectionPool } from "mssql";
import { settings } from "../config/settings.js";
import { logger } from "../observe/logger.js";

const log = logger.for("DB");

// MSSQL 连接池 —— 仅供未来的业务数据查询工具（如 NL2SQL）使用。
// 中台自身状态（事件/线程/审计/工具结果/线程摘要）已全面内存化，不再依赖此连接。

let poolPromise: Promise<IConnectionPool> | null = null;

export function getPool(): Promise<IConnectionPool> {
  if (!poolPromise) {
    poolPromise = sql.connect({
      server: settings.DB_HOST,
      port: settings.DB_PORT,
      user: settings.DB_USER,
      password: settings.DB_PASSWORD,
      database: settings.DB_NAME,
      connectionTimeout: 5_000,
      requestTimeout: 15_000,
      options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
    });

    poolPromise.then(
      (pool) => {
        (pool as unknown as NodeJS.EventEmitter).on("error", (err: Error) => {
          log.error("Pool error event", { err: err.message });
        });
      },
      (err: Error) => {
        log.error("Connection pool failed", { err: err.message });
        poolPromise = null;
      }
    );
    poolPromise.catch(() => {});
  }
  return poolPromise;
}

// 中台已全面内存化，不再建表。保留函数供 server.ts 启动调用（noop，不连 DB）。
// 若未来接入需要业务库的工具，由该工具自行保证其所需 schema。
export async function ensureSchema(): Promise<void> {
  return;
}

// 关闭连接池（测试/优雅停机用）
export async function closePool(): Promise<void> {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }
}

export { sql };
