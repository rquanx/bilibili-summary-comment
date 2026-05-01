import { z } from "zod";
import { resolveManagedSettings } from "../config/managed-settings";

const summaryConfigSchema = z.object({
  model: z.string().trim().min(1),
  apiKey: z.string(),
  apiBaseUrl: z.string().trim().url(),
  apiFormat: z.enum(["auto", "responses", "openai-chat", "anthropic-messages"]),
  promptConfigPath: z.string().trim().min(1).nullable(),
});

type SummaryConfig = z.infer<typeof summaryConfigSchema>;

interface SummaryConfigArgs extends Record<string, unknown> {
  db?: unknown;
  model?: unknown;
  ["api-key"]?: unknown;
  ["api-base-url"]?: unknown;
  ["api-format"]?: unknown;
  ["prompt-config"]?: unknown;
}

export function resolveSummaryConfig(args: SummaryConfigArgs = {}, env = process.env): SummaryConfig {
  const dbPath = String((args as { db?: unknown }).db ?? env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3").trim() || "work/pipeline.sqlite3";
  const managed = resolveManagedSettings({
    dbPath,
    env,
  });

  return summaryConfigSchema.parse({
    model: args.model ?? managed.summary.model,
    apiKey: args["api-key"] ?? env.SUMMARY_API_KEY ?? env.OPENAI_API_KEY ?? "",
    apiBaseUrl: normalizeSummaryApiBaseUrl(
      args["api-base-url"] ?? managed.summary.apiBaseUrl,
    ),
    apiFormat: normalizeSummaryApiFormat(
      args["api-format"] ?? managed.summary.apiFormat,
    ),
    promptConfigPath: normalizeOptionalSummaryPromptConfigPath(
      args["prompt-config"] ?? managed.summary.promptConfigPath,
    ),
  });
}

export function normalizeSummaryApiBaseUrl(value: unknown): string {
  return String(value ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function normalizeSummaryApiFormat(value: unknown): SummaryConfig["apiFormat"] {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (normalized === "responses" || normalized === "openai-chat" || normalized === "anthropic-messages") {
    return normalized;
  }
  return "auto";
}

function normalizeOptionalSummaryPromptConfigPath(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
