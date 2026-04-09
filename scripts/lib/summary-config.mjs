import { z } from "zod";

const summaryConfigSchema = z.object({
  model: z.string().trim().min(1),
  apiKey: z.string(),
  apiBaseUrl: z.string().trim().url(),
  apiFormat: z.enum(["auto", "responses", "openai-chat", "anthropic-messages"]),
});

export function resolveSummaryConfig(args = {}, env = process.env) {
  return summaryConfigSchema.parse({
    model: args.model ?? env.SUMMARY_MODEL ?? env.OPENAI_MODEL ?? "gpt-4o-mini",
    apiKey: args["api-key"] ?? env.SUMMARY_API_KEY ?? env.OPENAI_API_KEY ?? "",
    apiBaseUrl: normalizeSummaryApiBaseUrl(
      args["api-base-url"] ?? env.SUMMARY_API_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    ),
    apiFormat: normalizeSummaryApiFormat(
      args["api-format"] ?? env.SUMMARY_API_FORMAT ?? env.OPENAI_API_FORMAT ?? "auto",
    ),
  });
}

export function normalizeSummaryApiBaseUrl(value) {
  return String(value ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function normalizeSummaryApiFormat(value) {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (normalized === "responses" || normalized === "openai-chat" || normalized === "anthropic-messages") {
    return normalized;
  }
  return "auto";
}
