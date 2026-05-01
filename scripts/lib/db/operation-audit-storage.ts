import { sql } from "drizzle-orm";
import { withDatabaseWriteLock } from "./database";
import type { Db, OperationAuditInsert, OperationAuditRecord } from "./types";

export function insertOperationAudit(db: Db, audit: OperationAuditInsert): OperationAuditRecord {
  const now = new Date().toISOString();

  return withDatabaseWriteLock(db, () => {
    db.run(sql`
      INSERT INTO operation_audits (
        action,
        scope,
        trigger_source,
        bvid,
        run_id,
        request_json,
        status,
        result_json,
        error_message,
        created_at,
        updated_at
      )
      VALUES (
        ${requireText(audit.action, "action")},
        ${requireText(audit.scope, "scope")},
        ${normalizeText(audit.triggerSource) ?? "web"},
        ${normalizeText(audit.bvid)},
        ${normalizeText(audit.runId)},
        ${serializeJson(audit.request)},
        ${normalizeText(audit.status) ?? "started"},
        ${null},
        ${null},
        ${now},
        ${now}
      )
    `);

    return getLastInsertedOperationAudit(db);
  });
}

export function updateOperationAudit(
  db: Db,
  auditId: number,
  {
    status,
    runId,
    result,
    errorMessage,
  }: {
    status: string;
    runId?: string | null;
    result?: unknown;
    errorMessage?: string | null;
  },
): OperationAuditRecord | null {
  const now = new Date().toISOString();

  return withDatabaseWriteLock(db, () => {
    db.run(sql`
      UPDATE operation_audits
      SET status = ${requireText(status, "status")},
          run_id = COALESCE(${normalizeText(runId)}, run_id),
          result_json = ${serializeJson(result)},
          error_message = ${normalizeText(errorMessage)},
          updated_at = ${now}
      WHERE id = ${normalizeInteger(auditId)}
    `);

    return getOperationAuditById(db, auditId);
  });
}

export function getOperationAuditById(db: Db, auditId: number): OperationAuditRecord | null {
  return db.get<OperationAuditRecord>(sql`
    SELECT *
    FROM operation_audits
    WHERE id = ${normalizeInteger(auditId)}
  `) ?? null;
}

export function listOperationAudits(
  db: Db,
  {
    bvid = null,
    limit = 50,
  }: {
    bvid?: string | null;
    limit?: number;
  } = {},
): OperationAuditRecord[] {
  return db.all<OperationAuditRecord>(sql`
    SELECT *
    FROM operation_audits
    WHERE (${normalizeText(bvid)} IS NULL OR bvid = ${normalizeText(bvid)})
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.max(1, Number(limit) || 50)}
  `);
}

function getLastInsertedOperationAudit(db: Db): OperationAuditRecord {
  const record = db.get<OperationAuditRecord>(sql`
    SELECT *
    FROM operation_audits
    WHERE id = last_insert_rowid()
  `);
  if (!record) {
    throw new Error("Failed to load inserted operation audit");
  }

  return record;
}

function serializeJson(payload: unknown): string | null {
  if (payload === undefined || payload === null) {
    return null;
  }

  return `${JSON.stringify(payload)}\n`;
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requireText(value: unknown, fieldName: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`Missing required operation audit field: ${fieldName}`);
  }

  return normalized;
}

function normalizeInteger(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized)) {
    throw new Error(`Expected integer id, received: ${String(value ?? "")}`);
  }

  return normalized;
}
