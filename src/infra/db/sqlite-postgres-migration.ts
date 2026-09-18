import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Pool, types as pgTypes } from "pg";

pgTypes.setTypeParser(20, (value) => Number(value));

interface MigrationTable {
  name: string;
  columns: string[];
  sequenceColumn?: string;
}

const MIGRATION_TABLES: MigrationTable[] = [
  {
    name: "videos",
    columns: [
      "id", "bvid", "aid", "title", "owner_mid", "owner_name", "owner_dir_name",
      "work_dir_name", "source_type", "publish_enabled", "page_count",
      "root_comment_rpid", "top_comment_rpid", "preserved_top_comment_rpid",
      "publish_needs_rebuild", "publish_rebuild_reason", "last_scan_at",
      "created_at", "updated_at",
    ],
    sequenceColumn: "id",
  },
  {
    name: "video_parts",
    columns: [
      "id", "video_id", "page_no", "cid", "part_title", "duration_sec",
      "subtitle_path", "subtitle_source", "subtitle_lang", "source_path",
      "subtitle_text", "prompt_text", "summary_text", "summary_text_processed",
      "summary_hash", "published", "published_comment_rpid", "published_at",
      "is_deleted", "deleted_at", "created_at", "updated_at",
    ],
    sequenceColumn: "id",
  },
  {
    name: "pipeline_events",
    columns: [
      "id", "run_id", "video_id", "bvid", "video_title", "page_no", "cid",
      "part_title", "scope", "action", "status", "message", "details_json", "created_at",
    ],
    sequenceColumn: "id",
  },
  {
    name: "pipeline_runs",
    columns: [
      "run_id", "video_id", "bvid", "video_title", "trigger_source", "status",
      "started_at", "finished_at", "created_at", "updated_at",
    ],
  },
  {
    name: "pipeline_run_state",
    columns: [
      "run_id", "latest_event_id", "video_id", "bvid", "video_title",
      "trigger_source", "run_status", "current_scope", "current_action",
      "current_status", "current_stage", "current_page_no", "current_cid",
      "current_part_title", "last_message", "last_error_message", "failed_scope",
      "failed_action", "failed_step", "log_path", "summary_path",
      "pending_summary_path", "started_at", "finished_at", "updated_at",
    ],
  },
  {
    name: "gap_notifications",
    columns: [
      "id", "gap_key", "bvid", "video_title", "from_page_no", "from_cid",
      "to_page_no", "to_cid", "gap_start_at", "gap_end_at", "gap_seconds",
      "notified_at", "created_at", "updated_at",
    ],
    sequenceColumn: "id",
  },
  {
    name: "recent_reprocess_runs",
    columns: [
      "id", "video_id", "bvid", "video_title", "candidate_key", "reasons_json",
      "paste_pages_json", "status", "error_message", "details_json", "created_at",
      "updated_at", "finished_at",
    ],
    sequenceColumn: "id",
  },
  {
    name: "app_settings",
    columns: ["setting_key", "value_json", "created_at", "updated_at"],
  },
  {
    name: "scheduler_status",
    columns: [
      "scheduler_key", "status", "mode", "timezone", "pid", "hostname",
      "summary_users", "summary_concurrency", "current_tasks_json",
      "last_summary_at", "last_publish_at", "last_gap_check_at",
      "last_retry_failures_at", "last_zombie_recovery_at", "last_refresh_at",
      "last_cleanup_at", "last_error", "started_at", "last_heartbeat_at",
      "created_at", "updated_at",
    ],
  },
  {
    name: "operation_audits",
    columns: [
      "id", "action", "scope", "trigger_source", "bvid", "run_id",
      "request_json", "status", "result_json", "error_message", "created_at",
      "updated_at",
    ],
    sequenceColumn: "id",
  },
];

export interface SqliteToPostgresMigrationOptions {
  sqlitePath: string;
  postgresUrl: string;
  schemaPath?: string;
  reset?: boolean;
  batchSize?: number;
  onLog?: (message: string) => void;
}

export async function migrateSqliteToPostgres({
  sqlitePath,
  postgresUrl,
  schemaPath = path.resolve("postgres/schema.sql"),
  reset = false,
  batchSize = 500,
  onLog = () => {},
}: SqliteToPostgresMigrationOptions) {
  const resolvedSqlitePath = path.resolve(sqlitePath);
  const resolvedSchemaPath = path.resolve(schemaPath);
  if (!fs.existsSync(resolvedSqlitePath)) {
    throw new Error(`SQLite database not found: ${resolvedSqlitePath}`);
  }
  if (!fs.existsSync(resolvedSchemaPath)) {
    throw new Error(`PostgreSQL schema not found: ${resolvedSchemaPath}`);
  }

  const sqlite = new BetterSqlite3(resolvedSqlitePath, {
    readonly: true,
    fileMustExist: true,
  });
  const pool = new Pool({
    connectionString: postgresUrl,
    max: 2,
  });
  const client = await pool.connect();
  const safeBatchSize = Math.max(1, Math.min(2_000, Math.floor(batchSize) || 500));
  const startedAt = Date.now();

  try {
    onLog(`Applying PostgreSQL schema from ${resolvedSchemaPath}`);
    await client.query(fs.readFileSync(resolvedSchemaPath, "utf8"));
    await ensureTargetIsReady(client, reset);

    await client.query("BEGIN");
    await client.query("SET LOCAL synchronous_commit = OFF");
    if (reset) {
      await truncateMigrationTables(client);
    }

    const migrated: Record<string, number> = {};
    for (const table of MIGRATION_TABLES) {
      const count = readSqliteCount(sqlite, table.name);
      onLog(`Migrating ${table.name}: ${count} row(s)`);
      await migrateTable({
        sqlite,
        client,
        table,
        count,
        batchSize: safeBatchSize,
        onLog,
      });
      migrated[table.name] = count;
    }

    for (const table of MIGRATION_TABLES) {
      if (table.sequenceColumn) {
        await resetPostgresSequence(client, table.name, table.sequenceColumn);
      }
    }
    await client.query("COMMIT");

    const verification = await verifyMigrationCounts(sqlite, client);
    const mismatches = verification.filter((entry) => entry.sqliteCount !== entry.postgresCount);
    if (mismatches.length > 0) {
      throw new Error(
        `Migration count verification failed: ${mismatches.map((entry) => (
          `${entry.table} sqlite=${entry.sqliteCount} postgres=${entry.postgresCount}`
        )).join(", ")}`,
      );
    }

    const durationMs = Date.now() - startedAt;
    onLog(`Migration verified in ${(durationMs / 1000).toFixed(1)}s`);
    return {
      sqlitePath: resolvedSqlitePath,
      schemaPath: resolvedSchemaPath,
      migrated,
      verification,
      durationMs,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  } finally {
    sqlite.close();
    client.release();
    await pool.end();
  }
}

async function ensureTargetIsReady(client, reset: boolean) {
  const counts = [];
  for (const table of MIGRATION_TABLES) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table.name)}`);
    counts.push({
      table: table.name,
      count: Number(result.rows[0]?.count ?? 0),
    });
  }
  const populated = counts.filter((entry) => entry.count > 0);
  if (populated.length > 0 && !reset) {
    throw new Error(
      `PostgreSQL target is not empty (${populated.map((entry) => `${entry.table}=${entry.count}`).join(", ")}). Use --reset to replace it.`,
    );
  }
}

async function truncateMigrationTables(client) {
  const names = [...MIGRATION_TABLES]
    .reverse()
    .map((table) => quoteIdentifier(table.name))
    .join(", ");
  await client.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function migrateTable({
  sqlite,
  client,
  table,
  count,
  batchSize,
  onLog,
}: {
  sqlite: InstanceType<typeof BetterSqlite3>;
  client: import("pg").PoolClient;
  table: MigrationTable;
  count: number;
  batchSize: number;
  onLog: (message: string) => void;
}) {
  if (count === 0) {
    return;
  }

  const quotedColumns = table.columns.map(quoteIdentifier).join(", ");
  const selectSql = `SELECT ${quotedColumns} FROM ${quoteIdentifier(table.name)} ORDER BY rowid`;
  const iterator = sqlite.prepare(selectSql).iterate() as Iterable<Record<string, unknown>>;
  let batch: Record<string, unknown>[] = [];
  let migrated = 0;

  for (const row of iterator) {
    batch.push(row);
    if (batch.length >= batchSize) {
      await insertBatch(client, table, batch);
      migrated += batch.length;
      batch = [];
      if (migrated % Math.max(batchSize, 10_000) === 0 || migrated === count) {
        onLog(`Migrated ${table.name}: ${migrated}/${count}`);
      }
    }
  }
  if (batch.length > 0) {
    await insertBatch(client, table, batch);
    migrated += batch.length;
    onLog(`Migrated ${table.name}: ${migrated}/${count}`);
  }
}

async function insertBatch(
  client: import("pg").PoolClient,
  table: MigrationTable,
  rows: Record<string, unknown>[],
) {
  const values: unknown[] = [];
  const groups = rows.map((row) => {
    const placeholders = table.columns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const columns = table.columns.map(quoteIdentifier).join(", ");
  await client.query(
    `INSERT INTO ${quoteIdentifier(table.name)} (${columns}) VALUES ${groups.join(", ")}`,
    values,
  );
}

async function resetPostgresSequence(
  client: import("pg").PoolClient,
  tableName: string,
  columnName: string,
) {
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence($1, $2),
       COALESCE((SELECT MAX(${quoteIdentifier(columnName)}) FROM ${quoteIdentifier(tableName)}), 1),
       EXISTS(SELECT 1 FROM ${quoteIdentifier(tableName)})
     )`,
    [tableName, columnName],
  );
}

async function verifyMigrationCounts(
  sqlite: InstanceType<typeof BetterSqlite3>,
  client: import("pg").PoolClient,
) {
  const verification: Array<{
    table: string;
    sqliteCount: number;
    postgresCount: number;
  }> = [];

  for (const table of MIGRATION_TABLES) {
    const sqliteCount = readSqliteCount(sqlite, table.name);
    const result = await client.query(
      `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table.name)}`,
    );
    verification.push({
      table: table.name,
      sqliteCount,
      postgresCount: Number(result.rows[0]?.count ?? 0),
    });
  }
  return verification;
}

function readSqliteCount(
  sqlite: InstanceType<typeof BetterSqlite3>,
  tableName: string,
): number {
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
  ).get() as { count?: number };
  return Number(row?.count ?? 0);
}

function quoteIdentifier(value: string): string {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}
