import { z } from "zod";
import cron from "node-cron";
import { DEFAULT_AUTH_FILE } from "../bili/auth";
import { listAppSettings, openDatabase } from "../db/index";
import type { AppSettingRecord } from "../db/index";
import { parseSummaryPromptConfigContent } from "../summary/prompt-config";

const DEFAULT_GAP_CHECK_SINCE_HOURS = 24;
const DEFAULT_GAP_THRESHOLD_SECONDS = 5;
const DEFAULT_SUMMARY_CRON = "0,30 * * * *";
const DEFAULT_PUBLISH_CRON = "5 * * * *";
const DEFAULT_GAP_CHECK_CRON = "10 * * * *";
const DEFAULT_RETRY_FAILURES_CRON = "20 * * * *";
const DEFAULT_ZOMBIE_RECOVERY_CRON = "25 * * * *";
const DEFAULT_REFRESH_CRON = "15 3 * * *";
const DEFAULT_CLEANUP_CRON = "45 3 * * *";
const DEFAULT_PUBLISH_APPEND_COOLDOWN_MIN_MS = 15_000;
const DEFAULT_PUBLISH_APPEND_COOLDOWN_MAX_MS = 30_000;
const DEFAULT_PUBLISH_REBUILD_COOLDOWN_MIN_MS = 15_000;
const DEFAULT_PUBLISH_REBUILD_COOLDOWN_MAX_MS = 30_000;
const DEFAULT_ZOMBIE_RECOVERY_STALE_MS = 15 * 60 * 1000;
const DEFAULT_PUBLISH_MAX_CONCURRENT = 2;
const DEFAULT_PUBLISH_HEALTHCHECK_SINCE_HOURS = 24;

const zombieRecoveryStateSchema = z.enum(["missing-lock", "orphaned-lock", "stalled"]);
const rebuildPrioritySchema = z.enum(["append-first", "rebuild-first"]);

const nonEmptyStringSchema = z.string().trim().min(1);
const cronExpressionSchema = z.string().trim().min(1).refine((value) => cron.validate(value), {
  message: "invalid cron expression",
});
const positiveIntegerLikeSchema = z.coerce.number().int().positive();
const nullableTrimmedStringSchema = z.union([z.string(), z.null()]).transform((value) => {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
});
const optionalTrimmedStringSchema = z.union([z.string(), z.null(), z.undefined()]).transform((value) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
});

const managedSchedulerSettingsSchema = z.object({
  authFile: nonEmptyStringSchema,
  cookieFile: nullableTrimmedStringSchema,
  timezone: nullableTrimmedStringSchema,
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
  zombieRecoveryStates: z.string().trim().refine((value) => {
    const states = parseRecoveryStateList(value);
    return states.length > 0;
  }, {
    message: "zombie recovery states must include at least one valid state",
  }),
  refreshDays: positiveIntegerLikeSchema,
  cleanupDays: positiveIntegerLikeSchema,
  gapCheckSinceHours: positiveIntegerLikeSchema,
  gapThresholdSeconds: positiveIntegerLikeSchema,
  summaryCron: cronExpressionSchema,
  publishCron: cronExpressionSchema,
  gapCheckCron: cronExpressionSchema,
  retryFailuresCron: cronExpressionSchema,
  zombieRecoveryCron: cronExpressionSchema,
  refreshCron: cronExpressionSchema,
  cleanupCron: cronExpressionSchema,
});

const managedSummarySettingsSchema = z.object({
  model: nonEmptyStringSchema,
  apiBaseUrl: z.string().trim().url().transform((value) => value.replace(/\/+$/, "")),
  apiFormat: z.enum(["auto", "responses", "openai-chat", "anthropic-messages"]),
  promptConfigPath: nullableTrimmedStringSchema,
  promptConfigContent: z.union([z.string(), z.null()]).transform((value, context) => {
    if (value === null) {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    try {
      parseSummaryPromptConfigContent(normalized);
      return normalized;
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "invalid summary prompt config content",
      });
      return z.NEVER;
    }
  }),
});

const managedPublishSettingsSchema = z.object({
  appendCooldownMinMs: positiveIntegerLikeSchema,
  appendCooldownMaxMs: positiveIntegerLikeSchema,
  rebuildCooldownMinMs: positiveIntegerLikeSchema,
  rebuildCooldownMaxMs: positiveIntegerLikeSchema,
  maxConcurrent: positiveIntegerLikeSchema,
  healthcheckSinceHours: positiveIntegerLikeSchema,
  includeRecentPublishedHealthcheck: z.boolean(),
  stopOnFirstFailure: z.boolean(),
  rebuildPriority: rebuildPrioritySchema,
  cooldownOnlyWhenCommentsCreated: z.boolean(),
});

export const managedSettingsSchema = z.object({
  scheduler: managedSchedulerSettingsSchema,
  summary: managedSummarySettingsSchema,
  publish: managedPublishSettingsSchema,
}).superRefine((value, context) => {
  if (value.publish.appendCooldownMinMs > value.publish.appendCooldownMaxMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["publish", "appendCooldownMaxMs"],
      message: "append cooldown max must be greater than or equal to min",
    });
  }

  if (value.publish.rebuildCooldownMinMs > value.publish.rebuildCooldownMaxMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["publish", "rebuildCooldownMaxMs"],
      message: "rebuild cooldown max must be greater than or equal to min",
    });
  }
});

export const managedSettingsPatchSchema = z.object({
  scheduler: managedSchedulerSettingsSchema.partial().optional(),
  summary: managedSummarySettingsSchema.partial().optional(),
  publish: managedPublishSettingsSchema.partial().optional(),
}).refine((value) => hasOwnKeys(value.scheduler) || hasOwnKeys(value.summary) || hasOwnKeys(value.publish), {
  message: "settings patch must include at least one field",
});

export type ManagedSettings = z.infer<typeof managedSettingsSchema>;
export type ManagedSettingsPatch = z.infer<typeof managedSettingsPatchSchema>;

type SettingDefinition = {
  key: string;
  group: "scheduler" | "summary" | "publish";
  path: [string, string];
  label: string;
  description: string;
  input: "text" | "textarea" | "number" | "select";
  options?: string[];
  requiresRestart: boolean;
  effectiveScope: string;
};

const settingDefinitions: SettingDefinition[] = [
  {
    key: "scheduler.authFile",
    group: "scheduler",
    path: ["scheduler", "authFile"],
    label: "Auth File",
    description: "Base auth file path used to resolve per-user auth bundles.",
    input: "text",
    requiresRestart: false,
    effectiveScope: "applies to the next scheduler task run and the next manual sweep",
  },
  {
    key: "scheduler.cookieFile",
    group: "scheduler",
    path: ["scheduler", "cookieFile"],
    label: "Cookie File",
    description: "Optional explicit cookie file for upload scanning and health checks.",
    input: "text",
    requiresRestart: false,
    effectiveScope: "applies to the next scheduler task run",
  },
  {
    key: "scheduler.timezone",
    group: "scheduler",
    path: ["scheduler", "timezone"],
    label: "Cron Timezone",
    description: "Timezone label used by cron scheduling and schedule previews.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.summaryUsers",
    group: "scheduler",
    path: ["scheduler", "summaryUsers"],
    label: "Summary Users",
    description: "Comma-separated uploader space URLs or mids to scan.",
    input: "textarea",
    requiresRestart: false,
    effectiveScope: "applies to the next summary, publish, and gap-check sweep",
  },
  {
    key: "scheduler.summarySinceHours",
    group: "scheduler",
    path: ["scheduler", "summarySinceHours"],
    label: "Summary Window Hours",
    description: "How far back the summary sweep scans recent uploads.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next summary sweep",
  },
  {
    key: "scheduler.summaryConcurrency",
    group: "scheduler",
    path: ["scheduler", "summaryConcurrency"],
    label: "Summary Concurrency",
    description: "Max concurrent pipeline children for summary sweeps.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next summary sweep",
  },
  {
    key: "scheduler.retryFailuresLimit",
    group: "scheduler",
    path: ["scheduler", "retryFailuresLimit"],
    label: "Retry Failures Limit",
    description: "Max retryable failures to retrigger per retry sweep.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next retry-failures sweep",
  },
  {
    key: "scheduler.retryFailuresSinceHours",
    group: "scheduler",
    path: ["scheduler", "retryFailuresSinceHours"],
    label: "Retry Scan Hours",
    description: "Lookback window for retryable failures.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next retry-failures sweep",
  },
  {
    key: "scheduler.retryFailuresMaxRecent",
    group: "scheduler",
    path: ["scheduler", "retryFailuresMaxRecent"],
    label: "Retry Max Recent",
    description: "Max recent retries allowed per bvid in the retry window.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next retry-failures sweep",
  },
  {
    key: "scheduler.retryFailuresWindowHours",
    group: "scheduler",
    path: ["scheduler", "retryFailuresWindowHours"],
    label: "Retry Window Hours",
    description: "Recent retry window used for duplicate suppression.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next retry-failures sweep",
  },
  {
    key: "scheduler.zombieRecoveryEnabled",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryEnabled"],
    label: "Zombie Recovery Enabled",
    description: "Whether the scheduler should periodically auto-recover stale runs without a live lock.",
    input: "select",
    options: ["true", "false"],
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to add or remove the cron task",
  },
  {
    key: "scheduler.zombieRecoveryStaleMs",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryStaleMs"],
    label: "Zombie Stale Threshold (ms)",
    description: "How old a running pipeline must be before it is treated as a zombie recovery candidate.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next zombie-recovery sweep",
  },
  {
    key: "scheduler.zombieRecoveryLimit",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryLimit"],
    label: "Zombie Recovery Limit",
    description: "Max zombie candidates to recover per sweep.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next zombie-recovery sweep",
  },
  {
    key: "scheduler.zombieRecoveryMaxRecent",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryMaxRecent"],
    label: "Zombie Max Recent",
    description: "Max recent zombie recoveries allowed per bvid in the dedupe window.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next zombie-recovery sweep",
  },
  {
    key: "scheduler.zombieRecoveryWindowHours",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryWindowHours"],
    label: "Zombie Window Hours",
    description: "Lookback window used to suppress repeated zombie recoveries for the same video.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next zombie-recovery sweep",
  },
  {
    key: "scheduler.zombieRecoveryRetry",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryRetry"],
    label: "Retry After Recovery",
    description: "Whether zombie recovery should queue a fresh retry after the stale run is failed.",
    input: "select",
    options: ["true", "false"],
    requiresRestart: false,
    effectiveScope: "applies to the next zombie-recovery sweep",
  },
  {
    key: "scheduler.zombieRecoveryStates",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryStates"],
    label: "Zombie Recovery States",
    description: "Comma-separated recovery states that can be auto-recovered, for example missing-lock,orphaned-lock.",
    input: "text",
    requiresRestart: false,
    effectiveScope: "applies to the next zombie-recovery sweep",
  },
  {
    key: "scheduler.refreshDays",
    group: "scheduler",
    path: ["scheduler", "refreshDays"],
    label: "Auth Refresh Days",
    description: "Refresh auth when the bundle is older than this many days.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next refresh check",
  },
  {
    key: "scheduler.cleanupDays",
    group: "scheduler",
    path: ["scheduler", "cleanupDays"],
    label: "Work Cleanup Days",
    description: "Remove work directories older than this many days.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next cleanup task",
  },
  {
    key: "scheduler.gapCheckSinceHours",
    group: "scheduler",
    path: ["scheduler", "gapCheckSinceHours"],
    label: "Gap Check Window Hours",
    description: "Lookback window for recent upload gap checks.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next gap-check task",
  },
  {
    key: "scheduler.gapThresholdSeconds",
    group: "scheduler",
    path: ["scheduler", "gapThresholdSeconds"],
    label: "Gap Threshold Seconds",
    description: "Minimum missing duration treated as a real gap.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next gap-check task",
  },
  {
    key: "scheduler.summaryCron",
    group: "scheduler",
    path: ["scheduler", "summaryCron"],
    label: "Summary Cron",
    description: "Cron expression for recurring summary sweeps.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.publishCron",
    group: "scheduler",
    path: ["scheduler", "publishCron"],
    label: "Publish Cron",
    description: "Cron expression for recurring publish sweeps.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.gapCheckCron",
    group: "scheduler",
    path: ["scheduler", "gapCheckCron"],
    label: "Gap Check Cron",
    description: "Cron expression for recurring gap-check runs.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.retryFailuresCron",
    group: "scheduler",
    path: ["scheduler", "retryFailuresCron"],
    label: "Retry Failures Cron",
    description: "Cron expression for recurring retry-failures sweeps.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.zombieRecoveryCron",
    group: "scheduler",
    path: ["scheduler", "zombieRecoveryCron"],
    label: "Zombie Recovery Cron",
    description: "Cron expression for recurring zombie recovery sweeps.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.refreshCron",
    group: "scheduler",
    path: ["scheduler", "refreshCron"],
    label: "Auth Refresh Cron",
    description: "Cron expression for recurring auth refresh checks.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "scheduler.cleanupCron",
    group: "scheduler",
    path: ["scheduler", "cleanupCron"],
    label: "Cleanup Cron",
    description: "Cron expression for recurring work cleanup runs.",
    input: "text",
    requiresRestart: true,
    effectiveScope: "requires scheduler restart to rebuild cron jobs",
  },
  {
    key: "summary.model",
    group: "summary",
    path: ["summary", "model"],
    label: "Summary Model",
    description: "Primary model used for summary generation.",
    input: "text",
    requiresRestart: false,
    effectiveScope: "applies to the next pipeline child process",
  },
  {
    key: "summary.apiBaseUrl",
    group: "summary",
    path: ["summary", "apiBaseUrl"],
    label: "Summary API Base URL",
    description: "Base URL used for summary inference requests.",
    input: "text",
    requiresRestart: false,
    effectiveScope: "applies to the next pipeline child process",
  },
  {
    key: "summary.apiFormat",
    group: "summary",
    path: ["summary", "apiFormat"],
    label: "Summary API Format",
    description: "Request format used by the summary client.",
    input: "select",
    options: ["auto", "responses", "openai-chat", "anthropic-messages"],
    requiresRestart: false,
    effectiveScope: "applies to the next pipeline child process",
  },
  {
    key: "summary.promptConfigPath",
    group: "summary",
    path: ["summary", "promptConfigPath"],
    label: "Prompt Config Path",
    description: "Prompt preset file used to resolve summary prompt profiles.",
    input: "text",
    requiresRestart: false,
    effectiveScope: "applies to the next pipeline child process",
  },
  {
    key: "summary.promptConfigContent",
    group: "summary",
    path: ["summary", "promptConfigContent"],
    label: "Prompt Config Content",
    description: "Optional managed JSON content for prompt presets and per-user prompt rules. When set, it overrides the prompt config path.",
    input: "textarea",
    requiresRestart: false,
    effectiveScope: "applies to the next pipeline child process",
  },
  {
    key: "publish.appendCooldownMinMs",
    group: "publish",
    path: ["publish", "appendCooldownMinMs"],
    label: "Append Cooldown Min (ms)",
    description: "Minimum delay between append publish runs after comments are created.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.appendCooldownMaxMs",
    group: "publish",
    path: ["publish", "appendCooldownMaxMs"],
    label: "Append Cooldown Max (ms)",
    description: "Maximum delay between append publish runs after comments are created.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.rebuildCooldownMinMs",
    group: "publish",
    path: ["publish", "rebuildCooldownMinMs"],
    label: "Rebuild Cooldown Min (ms)",
    description: "Minimum delay between rebuild publish runs after comments are created.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.rebuildCooldownMaxMs",
    group: "publish",
    path: ["publish", "rebuildCooldownMaxMs"],
    label: "Rebuild Cooldown Max (ms)",
    description: "Maximum delay between rebuild publish runs after comments are created.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.maxConcurrent",
    group: "publish",
    path: ["publish", "maxConcurrent"],
    label: "Publish Max Concurrent",
    description: "Max queued publish tasks to execute in parallel before queue-lock throttling applies.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.healthcheckSinceHours",
    group: "publish",
    path: ["publish", "healthcheckSinceHours"],
    label: "Healthcheck Window Hours",
    description: "How far back the publish sweep scans recent uploads to healthcheck existing published threads.",
    input: "number",
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.includeRecentPublishedHealthcheck",
    group: "publish",
    path: ["publish", "includeRecentPublishedHealthcheck"],
    label: "Include Healthcheck Tasks",
    description: "Whether publish sweeps should include recent already-published videos for thread healthchecks.",
    input: "select",
    options: ["true", "false"],
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.stopOnFirstFailure",
    group: "publish",
    path: ["publish", "stopOnFirstFailure"],
    label: "Stop On First Failure",
    description: "Whether the publish queue should abort after the first failure instead of continuing the remaining tasks.",
    input: "select",
    options: ["true", "false"],
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.rebuildPriority",
    group: "publish",
    path: ["publish", "rebuildPriority"],
    label: "Rebuild Priority",
    description: "Whether append work or rebuild work should be scheduled first when both are queued.",
    input: "select",
    options: ["append-first", "rebuild-first"],
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
  {
    key: "publish.cooldownOnlyWhenCommentsCreated",
    group: "publish",
    path: ["publish", "cooldownOnlyWhenCommentsCreated"],
    label: "Cooldown On Comment Create",
    description: "Whether the publish queue should cool down only after a task actually created comments.",
    input: "select",
    options: ["true", "false"],
    requiresRestart: false,
    effectiveScope: "applies to the next publish sweep",
  },
];

export function resolveManagedSettings({
  dbPath = process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
  env = process.env,
  openDatabaseImpl = openDatabase,
  listAppSettingsImpl = listAppSettings,
}: {
  dbPath?: string;
  env?: Record<string, string | undefined>;
  openDatabaseImpl?: typeof openDatabase;
  listAppSettingsImpl?: typeof listAppSettings;
} = {}): ManagedSettings {
  const db = openDatabaseImpl(dbPath);
  try {
    return buildManagedSettingsFromRows(listAppSettingsImpl(db), env);
  } finally {
    db.close?.();
  }
}

export function buildManagedSettingsFromRows(
  rows: AppSettingRecord[],
  env: Record<string, string | undefined> = process.env,
): ManagedSettings {
  const next = buildDefaultManagedSettings(env);

  for (const definition of settingDefinitions) {
    const row = rows.find((item) => item.setting_key === definition.key);
    if (!row) {
      continue;
    }

    try {
      setNestedValue(next, definition.path, JSON.parse(row.value_json));
    } catch {
      continue;
    }
  }

  return managedSettingsSchema.parse(next);
}

export function buildDefaultManagedSettings(env: Record<string, string | undefined> = process.env): ManagedSettings {
  return managedSettingsSchema.parse({
    scheduler: {
      authFile: env.BILI_AUTH_FILE ?? DEFAULT_AUTH_FILE,
      cookieFile: normalizeOptionalString(env.BILI_COOKIE_FILE),
      timezone: normalizeOptionalString(env.CRON_TIMEZONE),
      summaryUsers: env.SUMMARY_USERS ?? "",
      summarySinceHours: env.SUMMARY_SINCE_HOURS ?? 24,
      summaryConcurrency: env.SUMMARY_PIPELINE_CONCURRENCY ?? 3,
      retryFailuresLimit: env.RETRY_FAILURES_LIMIT ?? 3,
      retryFailuresSinceHours: env.RETRY_FAILURES_SINCE_HOURS ?? 24 * 7,
      retryFailuresMaxRecent: env.RETRY_FAILURES_MAX_RECENT ?? 1,
      retryFailuresWindowHours: env.RETRY_FAILURES_WINDOW_HOURS ?? 6,
      zombieRecoveryEnabled: normalizeBooleanEnv(env.ZOMBIE_RECOVERY_ENABLED, true),
      zombieRecoveryStaleMs: env.ZOMBIE_RECOVERY_STALE_MS ?? DEFAULT_ZOMBIE_RECOVERY_STALE_MS,
      zombieRecoveryLimit: env.ZOMBIE_RECOVERY_LIMIT ?? 3,
      zombieRecoveryMaxRecent: env.ZOMBIE_RECOVERY_MAX_RECENT ?? 1,
      zombieRecoveryWindowHours: env.ZOMBIE_RECOVERY_WINDOW_HOURS ?? 6,
      zombieRecoveryRetry: normalizeBooleanEnv(env.ZOMBIE_RECOVERY_RETRY, true),
      zombieRecoveryStates: normalizeRecoveryStateList(env.ZOMBIE_RECOVERY_STATES) ?? "missing-lock,orphaned-lock",
      refreshDays: env.BILI_REFRESH_DAYS ?? 30,
      cleanupDays: env.WORK_CLEANUP_DAYS ?? 2,
      gapCheckSinceHours: env.GAP_CHECK_SINCE_HOURS ?? DEFAULT_GAP_CHECK_SINCE_HOURS,
      gapThresholdSeconds: env.GAP_CHECK_THRESHOLD_SECONDS ?? DEFAULT_GAP_THRESHOLD_SECONDS,
      summaryCron: env.SUMMARY_CRON ?? DEFAULT_SUMMARY_CRON,
      publishCron: env.PUBLISH_CRON ?? DEFAULT_PUBLISH_CRON,
      gapCheckCron: env.GAP_CHECK_CRON ?? DEFAULT_GAP_CHECK_CRON,
      retryFailuresCron: env.RETRY_FAILURES_CRON ?? DEFAULT_RETRY_FAILURES_CRON,
      zombieRecoveryCron: env.ZOMBIE_RECOVERY_CRON ?? DEFAULT_ZOMBIE_RECOVERY_CRON,
      refreshCron: env.REFRESH_CRON ?? DEFAULT_REFRESH_CRON,
      cleanupCron: env.CLEANUP_CRON ?? DEFAULT_CLEANUP_CRON,
    },
    summary: {
      model: env.SUMMARY_MODEL ?? env.OPENAI_MODEL ?? "gpt-4o-mini",
      apiBaseUrl: env.SUMMARY_API_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiFormat: env.SUMMARY_API_FORMAT ?? env.OPENAI_API_FORMAT ?? "auto",
      promptConfigPath: normalizeOptionalString(env.SUMMARY_PROMPT_CONFIG ?? "config/summary-prompts.json"),
      promptConfigContent: normalizeOptionalString(env.SUMMARY_PROMPT_CONFIG_CONTENT),
    },
    publish: {
      appendCooldownMinMs: env.PUBLISH_APPEND_COOLDOWN_MIN_MS ?? DEFAULT_PUBLISH_APPEND_COOLDOWN_MIN_MS,
      appendCooldownMaxMs: env.PUBLISH_APPEND_COOLDOWN_MAX_MS ?? DEFAULT_PUBLISH_APPEND_COOLDOWN_MAX_MS,
      rebuildCooldownMinMs: env.PUBLISH_REBUILD_COOLDOWN_MIN_MS ?? DEFAULT_PUBLISH_REBUILD_COOLDOWN_MIN_MS,
      rebuildCooldownMaxMs: env.PUBLISH_REBUILD_COOLDOWN_MAX_MS ?? DEFAULT_PUBLISH_REBUILD_COOLDOWN_MAX_MS,
      maxConcurrent: env.PUBLISH_MAX_CONCURRENT ?? DEFAULT_PUBLISH_MAX_CONCURRENT,
      healthcheckSinceHours: env.PUBLISH_HEALTHCHECK_SINCE_HOURS ?? DEFAULT_PUBLISH_HEALTHCHECK_SINCE_HOURS,
      includeRecentPublishedHealthcheck: normalizeBooleanEnv(env.PUBLISH_INCLUDE_RECENT_PUBLISHED_HEALTHCHECK, true),
      stopOnFirstFailure: normalizeBooleanEnv(env.PUBLISH_STOP_ON_FIRST_FAILURE, true),
      rebuildPriority: normalizeRebuildPriority(env.PUBLISH_REBUILD_PRIORITY) ?? "append-first",
      cooldownOnlyWhenCommentsCreated: normalizeBooleanEnv(env.PUBLISH_COOLDOWN_ONLY_WHEN_COMMENTS_CREATED, true),
    },
  });
}

export function flattenManagedSettings(settings: ManagedSettings): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const definition of settingDefinitions) {
    flattened[definition.key] = getNestedValue(settings, definition.path);
  }

  return flattened;
}

export function flattenManagedSettingsPatch(patch: ManagedSettingsPatch): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const definition of settingDefinitions) {
    const value = getNestedValue(patch, definition.path);
    if (value !== undefined) {
      flattened[definition.key] = value;
    }
  }

  return flattened;
}

export function mergeManagedSettings(
  current: ManagedSettings,
  patch: ManagedSettingsPatch,
): ManagedSettings {
  const next = cloneManagedSettings(current);

  for (const definition of settingDefinitions) {
    const value = getNestedValue(patch, definition.path);
    if (value !== undefined) {
      setNestedValue(next, definition.path, value);
    }
  }

  return managedSettingsSchema.parse(next);
}

export function listManagedSettingDefinitions() {
  return settingDefinitions.map((item) => ({ ...item }));
}

export function buildSchedulerPlan(
  scheduler: Pick<
    ManagedSettings["scheduler"],
    "timezone" | "summaryCron" | "publishCron" | "gapCheckCron" | "retryFailuresCron" | "zombieRecoveryCron" | "refreshCron" | "cleanupCron"
  >,
) {
  const effectiveTimezone = normalizeOptionalString(scheduler.timezone) ?? "system";

  return {
    timezone: effectiveTimezone,
    tasks: [
      {
        key: "summary",
        label: "Summary Sweep",
        cron: scheduler.summaryCron,
        description: "Scan configured users on the configured summary cadence.",
        requiresRestart: true,
      },
      {
        key: "publish",
        label: "Publish Sweep",
        cron: scheduler.publishCron,
        description: "Process the pending publish queue on the configured cadence.",
        requiresRestart: true,
      },
      {
        key: "gap-check",
        label: "Gap Check",
        cron: scheduler.gapCheckCron,
        description: "Check recent uploads for missing stream gaps on the configured cadence.",
        requiresRestart: true,
      },
      {
        key: "retry-failures",
        label: "Retry Failures",
        cron: scheduler.retryFailuresCron,
        description: "Retry retryable failures on the configured cadence.",
        requiresRestart: true,
      },
      {
        key: "zombie-recovery",
        label: "Zombie Recovery",
        cron: scheduler.zombieRecoveryCron,
        description: "Recover stale running pipelines that no longer hold a live lock.",
        requiresRestart: true,
      },
      {
        key: "refresh",
        label: "Auth Refresh",
        cron: scheduler.refreshCron,
        description: "Run the auth refresh check on the configured cadence.",
        requiresRestart: true,
      },
      {
        key: "cleanup",
        label: "Work Cleanup",
        cron: scheduler.cleanupCron,
        description: "Clean old work directories on the configured cadence.",
        requiresRestart: true,
      },
    ],
  };
}

function cloneManagedSettings(settings: ManagedSettings): ManagedSettings {
  return managedSettingsSchema.parse({
    scheduler: { ...settings.scheduler },
    summary: { ...settings.summary },
    publish: { ...settings.publish },
  });
}

function hasOwnKeys(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0);
}

function getNestedValue(value: unknown, path: [string, string]): unknown {
  const [first, second] = path;
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const firstValue = (value as Record<string, unknown>)[first];
  if (!firstValue || typeof firstValue !== "object") {
    return undefined;
  }

  return (firstValue as Record<string, unknown>)[second];
}

function setNestedValue(target: ManagedSettings, path: [string, string], value: unknown) {
  const [first, second] = path;
  const branch = target[first as keyof ManagedSettings];
  if (!branch || typeof branch !== "object") {
    return;
  }

  (branch as Record<string, unknown>)[second] = value;
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeBooleanEnv(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeRebuildPriority(value: unknown): "append-first" | "rebuild-first" | null {
  const normalized = String(value ?? "").trim();
  return normalized === "append-first" || normalized === "rebuild-first" ? normalized : null;
}

function parseRecoveryStateList(value: string): string[] {
  const states = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(states.filter((item) => zombieRecoveryStateSchema.safeParse(item).success))];
}

function normalizeRecoveryStateList(value: unknown): string | null {
  const states = parseRecoveryStateList(String(value ?? ""));
  return states.length > 0 ? states.join(",") : null;
}
