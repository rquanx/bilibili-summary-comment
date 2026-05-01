import {
  getOperationAuditById,
  insertOperationAudit,
  listOperationAudits,
  listAppSettings,
  openDatabase,
  updateOperationAudit,
  upsertAppSetting,
} from "../../../../scripts/lib/db/index";
import {
  buildManagedSettingsFromRows,
  buildSchedulerPlan,
  flattenManagedSettings,
  flattenManagedSettingsPatch,
  listManagedSettingDefinitions,
  managedSettingsPatchSchema,
  mergeManagedSettings,
} from "../../../../scripts/lib/config/managed-settings";
import type { OperationAuditRecord } from "../../../../scripts/lib/db/index";

export function createConfigService({
  dbPath = "work/pipeline.sqlite3",
  triggerSource = "web",
}: {
  dbPath?: string;
  triggerSource?: string;
} = {}) {
  const db = openDatabase(dbPath);

  return {
    close() {
      db.close?.();
    },
    getConfig() {
      const settings = readCurrentSettings(db);
      return {
        settings,
        definitions: listManagedSettingDefinitions(),
        schedule: buildSchedulerPlan(settings.scheduler),
      };
    },
    listHistory({
      limit = 20,
    }: {
      limit?: number;
    } = {}) {
      return listOperationAudits(db, {
        limit: Math.max(1, Number(limit) || 20),
      })
        .filter((item) => item.action === "config-update" || item.action === "config-rollback")
        .map(mapConfigAuditRecord)
        .filter((item) => item.status === "succeeded");
    },
    async updateSettings({
      patch,
    }: {
      patch: unknown;
    }) {
      const audit = insertOperationAudit(db, {
        action: "config-update",
        scope: "config",
        triggerSource,
        request: patch,
        status: "started",
      });

      try {
        const normalizedPatch = managedSettingsPatchSchema.parse(patch);
        const result = applySettingsChange(db, {
          currentSettings: readCurrentSettings(db),
          nextSettingsBuilder(currentSettings) {
            return mergeManagedSettings(currentSettings, normalizedPatch);
          },
          changedKeySource: flattenManagedSettingsPatch(normalizedPatch),
          reason: "manual-update",
        });
        updateOperationAudit(db, audit.id, {
          status: "succeeded",
          result,
        });

        return {
          ok: true,
          auditId: audit.id,
          action: "config-update",
          scope: "config",
          result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        updateOperationAudit(db, audit.id, {
          status: "failed",
          errorMessage,
          result: {
            errorMessage,
          },
        });

        return {
          ok: false,
          auditId: audit.id,
          action: "config-update",
          scope: "config",
          errorMessage,
        };
      }
    },
    async rollbackToAudit({
      auditId,
    }: {
      auditId: number;
    }) {
      const audit = insertOperationAudit(db, {
        action: "config-rollback",
        scope: "config",
        triggerSource,
        request: {
          auditId,
        },
        status: "started",
      });

      try {
        const sourceAudit = getOperationAuditById(db, auditId);
        if (!sourceAudit || (sourceAudit.action !== "config-update" && sourceAudit.action !== "config-rollback")) {
          throw new Error(`Unknown config audit: ${auditId}`);
        }

        if (sourceAudit.status !== "succeeded") {
          throw new Error(`Config audit is not restorable: ${auditId}`);
        }

        const sourceResult = parseJson(sourceAudit.result_json) as {
          settings?: unknown;
        } | null;
        if (!sourceResult?.settings || typeof sourceResult.settings !== "object") {
          throw new Error(`Config audit does not contain a settings snapshot: ${auditId}`);
        }

        const currentSettings = readCurrentSettings(db);
        const result = applySettingsChange(db, {
          currentSettings,
          nextSettingsBuilder() {
            return sourceResult.settings;
          },
          changedKeySource: flattenManagedSettings(sourceResult.settings as Parameters<typeof flattenManagedSettings>[0]),
          reason: "rollback",
          restoredFromAuditId: auditId,
        });
        updateOperationAudit(db, audit.id, {
          status: "succeeded",
          result,
        });

        return {
          ok: true,
          auditId: audit.id,
          action: "config-rollback",
          scope: "config",
          result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        updateOperationAudit(db, audit.id, {
          status: "failed",
          errorMessage,
          result: {
            errorMessage,
          },
        });

        return {
          ok: false,
          auditId: audit.id,
          action: "config-rollback",
          scope: "config",
          errorMessage,
        };
      }
    },
  };
}

function areJsonValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function readCurrentSettings(db: ReturnType<typeof openDatabase>) {
  return buildManagedSettingsFromRows(listAppSettings(db));
}

function applySettingsChange(
  db: ReturnType<typeof openDatabase>,
  {
    currentSettings,
    nextSettingsBuilder,
    changedKeySource,
    reason,
    restoredFromAuditId = null,
  }: {
    currentSettings: ReturnType<typeof readCurrentSettings>;
    nextSettingsBuilder: (currentSettings: ReturnType<typeof readCurrentSettings>) => unknown;
    changedKeySource: Record<string, unknown>;
    reason: string;
    restoredFromAuditId?: number | null;
  },
) {
  const nextSettings = mergeManagedSettings(currentSettings, nextSettingsBuilder(currentSettings) as Parameters<typeof mergeManagedSettings>[1]);
  const flattenedCurrent = flattenManagedSettings(currentSettings);
  const flattenedNext = flattenManagedSettings(nextSettings);
  const definitions = listManagedSettingDefinitions();
  const candidateKeys = Object.keys(changedKeySource);
  const changes = candidateKeys
    .filter((key) => !areJsonValuesEqual(flattenedCurrent[key], flattenedNext[key]))
    .map((key) => ({
      key,
      previousValue: flattenedCurrent[key] ?? null,
      nextValue: flattenedNext[key] ?? null,
      requiresRestart: definitions.find((item) => item.key === key)?.requiresRestart ?? false,
      effectiveScope: definitions.find((item) => item.key === key)?.effectiveScope ?? "applies on the next matching operation",
    }));

  for (const change of changes) {
    upsertAppSetting(db, {
      settingKey: change.key,
      value: change.nextValue,
    });
  }

  return {
    updated: changes.length > 0,
    reason,
    restoredFromAuditId,
    changedKeys: changes.map((item) => item.key),
    restartRequiredKeys: changes.filter((item) => item.requiresRestart).map((item) => item.key),
    changes,
    settings: nextSettings,
    schedule: buildSchedulerPlan(nextSettings.scheduler),
  };
}

function mapConfigAuditRecord(record: OperationAuditRecord) {
  const request = parseJson(record.request_json);
  const result = parseJson(record.result_json) as {
    updated?: boolean;
    changedKeys?: unknown;
    restartRequiredKeys?: unknown;
    restoredFromAuditId?: unknown;
    reason?: unknown;
    changes?: unknown;
    settings?: unknown;
  } | null;

  return {
    id: record.id,
    action: record.action,
    triggerSource: record.trigger_source,
    status: record.status,
    request,
    errorMessage: record.error_message,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    updated: result?.updated === true,
    reason: normalizeText(result?.reason),
    restoredFromAuditId: normalizeInteger(result?.restoredFromAuditId),
    changedKeys: Array.isArray(result?.changedKeys) ? result?.changedKeys.map((item) => String(item ?? "").trim()).filter(Boolean) : [],
    restartRequiredKeys: Array.isArray(result?.restartRequiredKeys) ? result?.restartRequiredKeys.map((item) => String(item ?? "").trim()).filter(Boolean) : [],
    changes: Array.isArray(result?.changes) ? result.changes : [],
    settings: result?.settings ?? null,
  };
}

function parseJson(value: string | null): unknown {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return normalized;
  }
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}
