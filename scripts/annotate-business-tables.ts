// Annotate ai_platform_db (ERP) tables/columns with MS_Description.
// This is the "semantic layer" that gives the model database literacy:
// list_tables/describe_table read these descriptions so the model understands
// business meaning without guessing from raw column names.
//
// Idempotent: drops then adds (safe to re-run). Edit the SPEC below and run:
//   npx tsx scripts/annotate-business-tables.ts
//
// To discover tables/columns first, run with --list flag:
//   npx tsx scripts/annotate-business-tables.ts --list
import { getPool } from "../src/persistence/db.js";

// ──────────────────────────────────────────────────────────
// SEMANTIC SPECIFICATION — edit this to add/update annotations.
// Table names must match INFORMATION_SCHEMA.TABLES.TABLE_NAME exactly.
// ──────────────────────────────────────────────────────────
const SPEC: { table: string; comment?: string; columns?: Record<string, string> }[] = [
  // Example entries — replace with your actual business table annotations:
  // {
  //   table: "t_SaleOrder",
  //   comment: "Sales order header. One row per sales order with customer, amount, status.",
  //   columns: {
  //     FBillNo: "Order number, format SO-YYYY-NNNN",
  //     FCustID: "Customer ID (FK to t_Customer.FItemID)",
  //     FDate: "Order date",
  //     FStatus: "0=open, 1=partial ship, 2=fully shipped, 3=cancelled",
  //   },
  // },
];

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

async function listTables() {
  const pool = await getPool();
  const res = await pool.request().query(`
    SELECT t.TABLE_NAME,
           (SELECT CAST(ep.value AS NVARCHAR(MAX)) FROM sys.extended_properties ep
            WHERE ep.major_id = OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME)
              AND ep.minor_id = 0 AND ep.name = 'MS_Description') AS tbl_comment,
           c.COLUMN_NAME,
           c.DATA_TYPE,
           (SELECT CAST(ep.value AS NVARCHAR(MAX)) FROM sys.extended_properties ep
            WHERE ep.major_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
              AND ep.minor_id = c.ORDINAL_POSITION
              AND ep.name = 'MS_Description') AS col_comment
    FROM INFORMATION_SCHEMA.TABLES t
    JOIN INFORMATION_SCHEMA.COLUMNS c
      ON c.TABLE_NAME = t.TABLE_NAME AND c.TABLE_SCHEMA = t.TABLE_SCHEMA
    WHERE t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
  `);

  const tables: Record<string, any> = {};
  for (const r of res.recordset as any[]) {
    if (!tables[r.TABLE_NAME]) {
      tables[r.TABLE_NAME] = { comment: r.tbl_comment || "", columns: [] };
    }
    tables[r.TABLE_NAME].columns.push({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
      comment: r.col_comment || "",
    });
  }

  console.log(`Found ${Object.keys(tables).length} tables in ai_platform_db:\n`);
  for (const [tname, info] of Object.entries(tables)) {
    const annotated = (info as any).comment ? " [annotated]" : "";
    const colsAnnotated = (info as any).columns.filter((c: any) => c.comment).length;
    const colsTotal = (info as any).columns.length;
    console.log(`  ${tname}${annotated} (${colsAnnotated}/${colsTotal} cols annotated)`);
    if (!(info as any).comment) {
      console.log(`    columns: ${(info as any).columns.map((c: any) => c.name).join(", ")}`);
    }
  }
}

async function setTableComment(table: string, comment: string): Promise<void> {
  const pool = await getPool();
  await pool.request().query(
    `EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA', N'dbo', N'TABLE', N'${esc(table)}'`
  ).catch(() => {});
  await pool.request().query(
    `EXEC sp_addextendedproperty N'MS_Description', N'${esc(comment)}', N'SCHEMA', N'dbo', N'TABLE', N'${esc(table)}'`
  );
}

async function setColumnComment(table: string, col: string, comment: string): Promise<void> {
  const pool = await getPool();
  await pool.request().query(
    `EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA', N'dbo', N'TABLE', N'${esc(table)}', N'COLUMN', N'${esc(col)}'`
  ).catch(() => {});
  await pool.request().query(
    `EXEC sp_addextendedproperty N'MS_Description', N'${esc(comment)}', N'SCHEMA', N'dbo', N'TABLE', N'${esc(table)}', N'COLUMN', N'${esc(col)}'`
  );
}

async function main() {
  if (process.argv.includes("--list")) {
    await listTables();
    return;
  }

  if (SPEC.length === 0) {
    console.log("SPEC is empty. Run with --list to discover tables, then fill in SPEC.");
    return;
  }

  let tblCount = 0;
  let colCount = 0;
  for (const spec of SPEC) {
    if (spec.comment) {
      await setTableComment(spec.table, spec.comment);
      tblCount++;
    }
    if (spec.columns) {
      for (const [col, c] of Object.entries(spec.columns)) {
        await setColumnComment(spec.table, col, c);
        colCount++;
      }
    }
    console.log(`  ${spec.table}: ${spec.comment ? "table + " : ""}${Object.keys(spec.columns || {}).length} cols`);
  }
  console.log(`\nDone: ${tblCount} table comments + ${colCount} column comments applied.`);

  // Verify
  await listTables();
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
