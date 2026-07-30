// guardSQL —— NL→SQL 的安全闸门：拦截一切写/破坏操作。
// query_database 是只读查询工具，绝不执行 DML/DDL/权限/过程调用。

const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\binsert\s+into\b/i, label: "INSERT" },
  { re: /\bupdate\b[\s\S]*?\bset\b/i, label: "UPDATE" },
  { re: /\bdelete\s+from\b/i, label: "DELETE" },
  { re: /\bdrop\b\s/i, label: "DROP" },
  { re: /\btruncate\b\s/i, label: "TRUNCATE" },
  { re: /\balter\b\s/i, label: "ALTER" },
  { re: /\bcreate\b\s/i, label: "CREATE" },
  { re: /\bgrant\b\s/i, label: "GRANT" },
  { re: /\brevoke\b\s/i, label: "REVOKE" },
  { re: /\bmerge\b\s/i, label: "MERGE" },
  { re: /\bexec(ute)?\s/i, label: "EXEC" },
  { re: /\bxp_|\bsp_/i, label: "系统存储过程" },
];

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

// 剥离注释后做关键字判断，防 /* */ 与 -- 绕过。
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

export function guardSQL(sql: string): GuardResult {
  const text = stripComments(sql ?? "");
  for (const { re, label } of FORBIDDEN) {
    if (re.test(text)) return { ok: false, reason: `禁止的写/破坏操作：${label}` };
  }
  // 顶层必须是 SELECT 或 WITH(CTE)
  if (!/^\s*\(?\s*(select|with)\b/i.test(text)) {
    return { ok: false, reason: "只允许 SELECT 或 WITH(CTE) 只读查询" };
  }
  return { ok: true };
}
