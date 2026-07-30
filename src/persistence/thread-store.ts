import { prisma } from "./prisma.js";
import { safeAppend, safeRead } from "./db-safe.js";
import { logger } from "../observe/logger.js";

const log = logger.for("thread-store");

// 线程元数据存储 —— Prisma(ai_harness_db.threads)。重启不丢。

export interface ThreadRecord {
  id: string;
  agentId: string;
  createdBy: string | null;
  title: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

function toDate(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function toRecord(r: {
  id: string;
  agentId: string;
  createdBy: string | null;
  title: string | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ThreadRecord {
  return {
    id: r.id,
    agentId: r.agentId,
    createdBy: r.createdBy,
    title: r.title,
    archived: r.archived,
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
  };
}

export async function upsertThread(params: {
  id: string;
  agentId: string;
  createdBy?: string | null;
  title?: string | null;
}): Promise<void> {
  await safeAppend(
    "upsertThread",
    () =>
      prisma.thread.upsert({
        where: { id: params.id },
        create: {
          id: params.id,
          agentId: params.agentId,
          createdBy: params.createdBy ?? null,
          title: params.title ?? null,
        },
        update: {
          agentId: params.agentId,
          // createdBy/title：传非 null 才更新，否则保留旧值（与原内存版 nullish 语义一致）
          ...(params.createdBy != null ? { createdBy: params.createdBy } : {}),
          ...(params.title != null ? { title: params.title } : {}),
        },
      }),
    log
  );
}

export async function getThread(id: string): Promise<ThreadRecord | null> {
  const row = await safeRead(() => prisma.thread.findUnique({ where: { id } }), null);
  return row ? toRecord(row) : null;
}

export async function listThreads(): Promise<ThreadRecord[]> {
  const rows = await safeRead(
    () => prisma.thread.findMany({ orderBy: { updatedAt: "desc" }, take: 500 }),
    []
  );
  return rows.map(toRecord);
}

export async function archiveThread(id: string): Promise<void> {
  await safeAppend(
    "archiveThread",
    () => prisma.thread.update({ where: { id }, data: { archived: true } }),
    log
  );
}
