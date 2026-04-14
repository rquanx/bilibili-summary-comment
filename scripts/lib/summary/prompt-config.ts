import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getRepoRoot } from "../shared/runtime-tools";

const promptRuleListSchema = z.array(z.string().trim().min(1)).default([]);

const promptPresetSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  extraRules: promptRuleListSchema,
});

const promptUserOverrideSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  preset: z.string().trim().min(1).optional(),
  extraRules: promptRuleListSchema,
});

const summaryPromptConfigSchema = z.object({
  defaults: promptPresetSchema.default({
    extraRules: [],
  }),
  presets: z.record(z.string(), promptPresetSchema).default({}),
  users: z.record(z.string(), promptUserOverrideSchema).default({}),
});

export type SummaryPromptConfigFile = z.infer<typeof summaryPromptConfigSchema>;

export interface ResolvedSummaryPromptProfile {
  ownerMid: number | null;
  displayName?: string;
  preset?: string;
  extraRules: string[];
}

interface LoadSummaryPromptConfigOptions {
  promptConfigPath?: string | null;
  repoRoot?: string;
  existsSync?: typeof fs.existsSync;
  readFileSync?: typeof fs.readFileSync;
}

interface ResolveSummaryPromptProfileOptions extends LoadSummaryPromptConfigOptions {
  ownerMid?: number | null;
}

export function resolveSummaryPromptConfigPath(
  value: unknown,
  {
    repoRoot = getRepoRoot(),
  }: {
    repoRoot?: string;
  } = {},
): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(repoRoot, normalized);
}

export function loadSummaryPromptConfig({
  promptConfigPath = "config/summary-prompts.json",
  repoRoot = getRepoRoot(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
}: LoadSummaryPromptConfigOptions = {}): SummaryPromptConfigFile {
  const resolvedConfigPath = resolveSummaryPromptConfigPath(promptConfigPath, {
    repoRoot,
  });
  if (!resolvedConfigPath || !existsSync(resolvedConfigPath)) {
    return summaryPromptConfigSchema.parse({});
  }

  const raw = readFileSync(resolvedConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  return summaryPromptConfigSchema.parse(parsed);
}

export function resolveSummaryPromptProfile({
  ownerMid = null,
  promptConfigPath = "config/summary-prompts.json",
  repoRoot = getRepoRoot(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
}: ResolveSummaryPromptProfileOptions = {}): ResolvedSummaryPromptProfile {
  const config = loadSummaryPromptConfig({
    promptConfigPath,
    repoRoot,
    existsSync,
    readFileSync,
  });
  const ownerKey = normalizeOwnerMidKey(ownerMid);
  const userOverride = ownerKey ? config.users[ownerKey] : undefined;
  const presetName = userOverride?.preset;
  const preset = presetName ? config.presets[presetName] : undefined;

  if (presetName && !preset) {
    throw new Error(`Unknown summary prompt preset "${presetName}" for user ${ownerKey}`);
  }

  return {
    ownerMid: normalizeOwnerMid(ownerMid),
    displayName: userOverride?.displayName ?? preset?.displayName ?? config.defaults.displayName,
    preset: presetName,
    extraRules: [
      ...config.defaults.extraRules,
      ...(preset?.extraRules ?? []),
      ...(userOverride?.extraRules ?? []),
    ],
  };
}

function normalizeOwnerMid(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeOwnerMidKey(value: unknown): string {
  const normalized = normalizeOwnerMid(value);
  return normalized ? String(normalized) : "";
}
