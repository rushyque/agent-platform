import sql, { type IConnectionPool } from "mssql";
import { settings } from "../config/settings.js";
import { logger } from "../observe/logger.js";
import { prisma } from "./prisma.js";
import { loadThreadSummariesFromDb } from "../core/context/index.js";

const log = logger.for("DB");

// 业务库连接池（ai_platform_db）—— 仅供 db_demo 等项目的只读数据查询原语（run_sql 等）用。
// 中台自有状态库（ai_harness_db）走 Prisma（./prisma.ts），不在此。
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

// 启动期：ai_harness_db 连通性自检 + 线程摘要预加载（write-through 热缓存）。
// 不建表——schema 由 prisma migrate deploy 独立应用（生产 DDL 权限/并发安全）。
// 连不通会 throw，交 server.ts 启动 catch 记告警（不阻断启动；DB 读写在 db-safe 里各自降级）。
export async function ensureSchema(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  log.info("harness db connected", { database: settings.HARNESS_DB_NAME });
  await loadThreadSummariesFromDb();
}

// 关闭业务库连接池（测试/优雅停机用）
export async function closePool(): Promise<void> {
  if (poolPromise) {
    const pool = await poolPromise;
    await pool.close();
    poolPromise = null;
  }
}

export { sql };
