// 线程元数据存储 —— 纯内存。重启清空。（曾用 MSSQL threads 表。）

export interface ThreadRecord {
  id: string;
  agentId: string;
  createdBy: string | null;
  title: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const threads = new Map<string, ThreadRecord>();

function now(): string {
  return new Date(Date.now()).toISOString();
}

export async function upsertThread(params: {
  id: string;
  agentId: string;
  createdBy?: string | null;
  title?: string | null;
}): Promise<void> {
  const existing = threads.get(params.id);
  threads.set(params.id, {
    id: params.id,
    agentId: params.agentId,
    createdBy: params.createdBy ?? existing?.createdBy ?? null,
    title: params.title ?? existing?.title ?? null,
    archived: existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  });
}

export async function getThread(id: string): Promise<ThreadRecord | null> {
  return threads.get(id) ?? null;
}

export async function listThreads(): Promise<ThreadRecord[]> {
  return Array.from(threads.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function archiveThread(id: string): Promise<void> {
  const t = threads.get(id);
  if (t) {
    t.archived = true;
    t.updatedAt = now();
  }
}
