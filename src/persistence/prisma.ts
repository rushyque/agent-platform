import { PrismaClient } from "@prisma/client";
import { settings } from "../config/settings.js";

// 中台自有状态库（ai_harness_db）的 Prisma 单例。
// globalThis 缓存：防 tsx watch 热重载时重复 new PrismaClient() 开多个连接池。
// datasourceUrl 用 settings 拼的 sqlserver 串（运行时不依赖 process.env.HARNESS_DATABASE_URL）。
// 错误一律由调用方经 db-safe.ts 的 safeAppend/safeRead 捕获降级，故这里不挂 Prisma log。
const g = globalThis as unknown as { __harnessPrisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__harnessPrisma ??
  new PrismaClient({
    datasourceUrl: settings.HARNESS_DATABASE_URL,
  });

if (!g.__harnessPrisma) g.__harnessPrisma = prisma;

// 优雅停机：关闭连接池（server 退出时调）。
export async function closeHarnessPrisma(): Promise<void> {
  if (g.__harnessPrisma) {
    await g.__harnessPrisma.$disconnect();
    g.__harnessPrisma = undefined;
  }
}
