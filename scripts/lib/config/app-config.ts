import { z } from "zod";
import { DEFAULT_AUTH_FILE } from "../bili/auth";
import { resolveManagedSettings } from "./managed-settings";

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerLikeSchema = z.coerce.number().int().positive();
const optionalTrimmedStringSchema = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((value) => {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value.trim();
    return normalized || undefined;
  });

const cleanupConfigSchema = z.object({
  dbPath: nonEmptyStringSchema,
  workRoot: nonEmptyStringSchema,
  olderThanDays: positiveIntegerLikeSchema,
});

const summaryUsersConfigSchema = z.object({
  summaryUsers: z.string(),
  authFile: nonEmptyStringSchema,
  cookieFile: optionalTrimmedStringSchema,
  sinceHours: positiveIntegerLikeSchema,
  summaryConcurrency: positiveIntegerLikeSchema,
  dbPath: nonEmptyStringSchema,
  workRoot: nonEmptyStringSchema,
});

const schedulerConfigSchema = z.object({
  authFile: nonEmptyStringSchema,
  cookieFile: optionalTrimmedStringSchema,
  summaryUsers: z.string(),
  summarySinceHours: positiveIntegerLikeSchema,
  summaryConcurrency: positiveIntegerLikeSchema,
  retryFailuresLimit: positiveIntegerLikeSchema,
  retryFailuresSinceHours: positiveIntegerLikeSchema,
  retryFailuresMaxRecent: z.coerce.number().int().min(0),
  retryFailuresWindowHours: positiveIntegerLikeSchema,
  zombieRecoveryEnabled: z.boolean(),
  zombieRecoveryStaleMs: z.coerce.number().int().min(60_000),
  zombieRecoveryLimit: positiveIntegerLikeSchema,
  zombieRecoveryMaxRecent: z.coerce.number().int().min(0),
  zombieRecoveryWindowHours: positiveIntegerLikeSchema,
  zombieRecoveryRetry: z.boolean(),
  zombieRecoveryStates: nonEmptyStringSchema,
  gapCheckSinceHours: positiveIntegerLikeSchema,
  gapThresholdSeconds: positiveIntegerLikeSchema,
  refreshDays: positiveIntegerLikeSchema,
  cleanupDays: positiveIntegerLikeSchema,
  summaryCron: nonEmptyStringSchema,
  publishCron: nonEmptyStringSchema,
  gapCheckCron: nonEmptyStringSchema,
  retryFailuresCron: nonEmptyStringSchema,
  zombieRecoveryCron: nonEmptyStringSchema,
  refreshCron: nonEmptyStringSchema,
  cleanupCron: nonEmptyStringSchema,
  dbPath: nonEmptyStringSchema,
  workRoot: nonEmptyStringSchema,
  timezone: optionalTrimmedStringSchema,
});

const publishRuntimeConfigSchema = z.object({
  appendCooldownMinMs: positiveIntegerLikeSchema,
  appendCooldownMaxMs: positiveIntegerLikeSchema,
  rebuildCooldownMinMs: positiveIntegerLikeSchema,
  rebuildCooldownMaxMs: positiveIntegerLikeSchema,
  maxConcurrent: positiveIntegerLikeSchema,
  healthcheckSinceHours: positiveIntegerLikeSchema,
  includeRecentPublishedHealthcheck: z.boolean(),
  stopOnFirstFailure: z.boolean(),
  rebuildPriority: z.enum(["append-first", "rebuild-first"]),
  cooldownOnlyWhenCommentsCreated: z.boolean(),
});

type CleanupConfig = z.infer<typeof cleanupConfigSchema>;
type SummaryUsersConfig = z.infer<typeof summaryUsersConfigSchema>;
type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
type PublishRuntimeConfig = z.infer<typeof publishRuntimeConfigSchema>;

interface AppConfigOptions extends Record<string, unknown> {
  db?: unknown;
  timezone?: unknown;
  ["work-root"]?: unknown;
  ["cleanup-days"]?: unknown;
  ["summary-concurrency"]?: unknown;
  ["summary-users"]?: unknown;
  ["cookie-file"]?: unknown;
  ["summary-since-hours"]?: unknown;
  ["retry-failures-limit"]?: unknown;
  ["retry-failures-since-hours"]?: unknown;
  ["retry-failures-max-recent"]?: unknown;
  ["retry-failures-window-hours"]?: unknown;
  ["gap-check-since-hours"]?: unknown;
  ["gap-threshold-seconds"]?: unknown;
  ["auth-file"]?: unknown;
  ["refresh-days"]?: unknown;
}

export function resolveCleanupConfig(options: AppConfigOptions = {}): CleanupConfig {
  const env = process.env;
  const dbPath = String(options.db ?? env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3").trim() || "work/pipeline.sqlite3";
  const managed = resolveManagedSettings({
    dbPath,
    env,
  });

  return cleanupConfigSchema.parse({
    dbPath,
    workRoot: options["work-root"] ?? env.WORK_ROOT ?? "work",
    olderThanDays: options["cleanup-days"] ?? managed.scheduler.cleanupDays,
  });
}

export function resolveSummaryUsersConfig(options: AppConfigOptions = {}): SummaryUsersConfig {
  const env = process.env;
  const dbPath = String(options.db ?? env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3").trim() || "work/pipeline.sqlite3";
  const managed = resolveManagedSettings({
    dbPath,
    env,
  });

  return summaryUsersConfigSchema.parse({
    summaryUsers: options["summary-users"] ?? managed.scheduler.summaryUsers ?? "",
    authFile: options["auth-file"] ?? managed.scheduler.authFile ?? DEFAULT_AUTH_FILE,
    cookieFile: options["cookie-file"] ?? managed.scheduler.cookieFile,
    sinceHours: options["summary-since-hours"] ?? managed.scheduler.summarySinceHours,
    summaryConcurrency: options["summary-concurrency"] ?? managed.scheduler.summaryConcurrency,
    dbPath,
    workRoot: options["work-root"] ?? env.WORK_ROOT ?? "work",
  });
}

export function resolveSchedulerConfig(options: AppConfigOptions = {}): SchedulerConfig {
  const env = process.env;
  const dbPath = String(options.db ?? env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3").trim() || "work/pipeline.sqlite3";
  const managed = resolveManagedSettings({
    dbPath,
    env,
  });

  return schedulerConfigSchema.parse({
    authFile: options["auth-file"] ?? managed.scheduler.authFile ?? DEFAULT_AUTH_FILE,
    cookieFile: options["cookie-file"] ?? managed.scheduler.cookieFile,
    summaryUsers: options["summary-users"] ?? managed.scheduler.summaryUsers ?? "",
    summarySinceHours: options["summary-since-hours"] ?? managed.scheduler.summarySinceHours,
    summaryConcurrency: options["summary-concurrency"] ?? managed.scheduler.summaryConcurrency,
    retryFailuresLimit: options["retry-failures-limit"] ?? managed.scheduler.retryFailuresLimit,
    retryFailuresSinceHours: options["retry-failures-since-hours"] ?? managed.scheduler.retryFailuresSinceHours,
    retryFailuresMaxRecent: options["retry-failures-max-recent"] ?? managed.scheduler.retryFailuresMaxRecent,
    retryFailuresWindowHours: options["retry-failures-window-hours"] ?? managed.scheduler.retryFailuresWindowHours,
    zombieRecoveryEnabled: managed.scheduler.zombieRecoveryEnabled,
    zombieRecoveryStaleMs: managed.scheduler.zombieRecoveryStaleMs,
    zombieRecoveryLimit: managed.scheduler.zombieRecoveryLimit,
    zombieRecoveryMaxRecent: managed.scheduler.zombieRecoveryMaxRecent,
    zombieRecoveryWindowHours: managed.scheduler.zombieRecoveryWindowHours,
    zombieRecoveryRetry: managed.scheduler.zombieRecoveryRetry,
    zombieRecoveryStates: managed.scheduler.zombieRecoveryStates,
    gapCheckSinceHours: options["gap-check-since-hours"] ?? managed.scheduler.gapCheckSinceHours,
    gapThresholdSeconds: options["gap-threshold-seconds"] ?? managed.scheduler.gapThresholdSeconds,
    refreshDays: options["refresh-days"] ?? managed.scheduler.refreshDays,
    cleanupDays: options["cleanup-days"] ?? managed.scheduler.cleanupDays,
    summaryCron: managed.scheduler.summaryCron,
    publishCron: managed.scheduler.publishCron,
    gapCheckCron: managed.scheduler.gapCheckCron,
    retryFailuresCron: managed.scheduler.retryFailuresCron,
    zombieRecoveryCron: managed.scheduler.zombieRecoveryCron,
    refreshCron: managed.scheduler.refreshCron,
    cleanupCron: managed.scheduler.cleanupCron,
    dbPath,
    workRoot: options["work-root"] ?? env.WORK_ROOT ?? "work",
    timezone: options.timezone ?? managed.scheduler.timezone,
  });
}

export function resolvePublishRuntimeConfig(options: AppConfigOptions = {}): PublishRuntimeConfig {
  const env = process.env;
  const dbPath = String(options.db ?? env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3").trim() || "work/pipeline.sqlite3";
  const managed = resolveManagedSettings({
    dbPath,
    env,
  });

  return publishRuntimeConfigSchema.parse(managed.publish);
}
