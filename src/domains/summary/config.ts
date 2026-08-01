import { z } from "zod";

const summaryConfigSchema = z.object({
  model: z.string().trim().min(1),
  apiKey: z.string(),
  apiBaseUrl: z.string().trim().url(),
  apiFormat: z.enum(["auto", "responses", "openai-chat", "anthropic-messages"]),
  cliProxy: z.object({
    enabled: z.boolean(),
    model: z.string().trim().min(1),
    apiKey: z.string(),
    apiBaseUrl: z.string().trim().url(),
    apiFormat: z.enum(["auto", "responses", "openai-chat", "anthropic-messages"]),
  }),
  promptConfigPath: z.string().trim().min(1).nullable(),
});

type SummaryConfig = z.infer<typeof summaryConfigSchema>;

interface SummaryConfigArgs extends Record<string, unknown> {
  model?: unknown;
  ["api-key"]?: unknown;
  ["api-base-url"]?: unknown;
  ["api-format"]?: unknown;
  ["prompt-config"]?: unknown;
}

export function resolveSummaryConfig(args: SummaryConfigArgs = {}, env = process.env): SummaryConfig {
  const cliProxyApiKey = String(env.SUMMARY_CLI_PROXY_API_KEY ?? "").trim();

  return summaryConfigSchema.parse({
    model: args.model ?? env.SUMMARY_MODEL ?? env.OPENAI_MODEL ?? "gpt-4o-mini",
    apiKey: args["api-key"] ?? env.SUMMARY_API_KEY ?? env.OPENAI_API_KEY ?? "",
    apiBaseUrl: normalizeSummaryApiBaseUrl(
      args["api-base-url"] ?? env.SUMMARY_API_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    ),
    apiFormat: normalizeSummaryApiFormat(
      args["api-format"] ?? env.SUMMARY_API_FORMAT ?? env.OPENAI_API_FORMAT ?? "auto",
    ),
    cliProxy: {
      enabled: normalizeBoolean(env.SUMMARY_CLI_PROXY_ENABLED, Boolean(cliProxyApiKey)),
      model: env.SUMMARY_CLI_PROXY_MODEL ?? "gpt-5.6-luna",
      apiKey: cliProxyApiKey,
      apiBaseUrl: normalizeSummaryApiBaseUrl(
        env.SUMMARY_CLI_PROXY_API_BASE_URL ?? "http://host.docker.internal:8317/v1",
      ),
      apiFormat: normalizeSummaryApiFormat(env.SUMMARY_CLI_PROXY_API_FORMAT ?? "responses"),
    },
    promptConfigPath: normalizeOptionalSummaryPromptConfigPath(
      args["prompt-config"] ?? env.SUMMARY_PROMPT_CONFIG ?? "config/summary-prompts.json",
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

function normalizeBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }

  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}
