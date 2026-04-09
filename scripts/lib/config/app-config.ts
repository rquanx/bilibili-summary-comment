import { z } from "zod";

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
  cookieFile: nonEmptyStringSchema,
  sinceHours: positiveIntegerLikeSchema,
  dbPath: nonEmptyStringSchema,
  workRoot: nonEmptyStringSchema,
});

const schedulerConfigSchema = z.object({
  cookieFile: nonEmptyStringSchema,
  authFile: optionalTrimmedStringSchema,
  summaryUsers: z.string(),
  summarySinceHours: positiveIntegerLikeSchema,
  refreshDays: positiveIntegerLikeSchema,
  cleanupDays: positiveIntegerLikeSchema,
  dbPath: nonEmptyStringSchema,
  workRoot: nonEmptyStringSchema,
  timezone: optionalTrimmedStringSchema,
});

type CleanupConfig = z.infer<typeof cleanupConfigSchema>;
type SummaryUsersConfig = z.infer<typeof summaryUsersConfigSchema>;
type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

interface AppConfigOptions extends Record<string, unknown> {
  db?: unknown;
  timezone?: unknown;
  ["work-root"]?: unknown;
  ["cleanup-days"]?: unknown;
  ["summary-users"]?: unknown;
  ["cookie-file"]?: unknown;
  ["summary-since-hours"]?: unknown;
  ["auth-file"]?: unknown;
  ["refresh-days"]?: unknown;
}

export function resolveCleanupConfig(options: AppConfigOptions = {}): CleanupConfig {
  return cleanupConfigSchema.parse({
    dbPath: options.db ?? process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
    workRoot: options["work-root"] ?? process.env.WORK_ROOT ?? "work",
    olderThanDays: options["cleanup-days"] ?? process.env.WORK_CLEANUP_DAYS ?? 2,
  });
}

export function resolveSummaryUsersConfig(options: AppConfigOptions = {}): SummaryUsersConfig {
  return summaryUsersConfigSchema.parse({
    summaryUsers: options["summary-users"] ?? process.env.SUMMARY_USERS ?? "",
    cookieFile: options["cookie-file"] ?? process.env.BILI_COOKIE_FILE ?? "cookie.txt",
    sinceHours: options["summary-since-hours"] ?? process.env.SUMMARY_SINCE_HOURS ?? 24,
    dbPath: options.db ?? process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
    workRoot: options["work-root"] ?? process.env.WORK_ROOT ?? "work",
  });
}

export function resolveSchedulerConfig(options: AppConfigOptions = {}): SchedulerConfig {
  return schedulerConfigSchema.parse({
    cookieFile: options["cookie-file"] ?? process.env.BILI_COOKIE_FILE ?? "cookie.txt",
    authFile: options["auth-file"] ?? process.env.BILI_AUTH_FILE,
    summaryUsers: options["summary-users"] ?? process.env.SUMMARY_USERS ?? "",
    summarySinceHours: options["summary-since-hours"] ?? process.env.SUMMARY_SINCE_HOURS ?? 24,
    refreshDays: options["refresh-days"] ?? process.env.BILI_REFRESH_DAYS ?? 30,
    cleanupDays: options["cleanup-days"] ?? process.env.WORK_CLEANUP_DAYS ?? 2,
    dbPath: options.db ?? process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
    workRoot: options["work-root"] ?? process.env.WORK_ROOT ?? "work",
    timezone: options.timezone ?? process.env.CRON_TIMEZONE,
  });
}
