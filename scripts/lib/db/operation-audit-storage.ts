import { withDatabaseWriteLock } from "./database";
import type { Db, OperationAuditInsert, OperationAuditRecord } from "./types";

export function insertOperationAudit(db: Db, audit: OperationAuditInsert): OperationAuditRecord {
  const now = new Date().toISOString();

  return withDatabaseWriteLock(db, () => {
    db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireText(audit.action, "action"),
      requireText(audit.scope, "scope"),
      normalizeText(audit.triggerSource) ?? "web",
      normalizeText(audit.bvid),
      normalizeText(audit.runId),
      serializeJson(audit.request),
      normalizeText(audit.status) ?? "started",
      null,
      null,
      now,
      now,
    );

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
    db.prepare(`
      UPDATE operation_audits
      SET status = ?,
          run_id = COALESCE(?, run_id),
          result_json = ?,
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      requireText(status, "status"),
      normalizeText(runId),
      serializeJson(result),
      normalizeText(errorMessage),
      now,
      normalizeInteger(auditId),
    );

    return getOperationAuditById(db, auditId);
  });
}

export function getOperationAuditById(db: Db, auditId: number): OperationAuditRecord | null {
  return (db.prepare("SELECT * FROM operation_audits WHERE id = ?").get(normalizeInteger(auditId)) as unknown as OperationAuditRecord | undefined) ?? null;
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
  return db.prepare(`
    SELECT *
    FROM operation_audits
    WHERE (? IS NULL OR bvid = ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(
    normalizeText(bvid),
    normalizeText(bvid),
    Math.max(1, Number(limit) || 50),
  ) as unknown as OperationAuditRecord[];
}

function getLastInsertedOperationAudit(db: Db): OperationAuditRecord {
  return db.prepare("SELECT * FROM operation_audits WHERE id = last_insert_rowid()").get() as unknown as OperationAuditRecord;
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
