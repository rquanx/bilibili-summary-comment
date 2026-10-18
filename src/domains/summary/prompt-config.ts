import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getRepoRoot } from "../../shared/runtime-tools";

const promptRuleListSchema = z.array(z.string().trim().min(1)).default([]);
const promptRegexListSchema = z.array(z.string().trim().min(1)).superRefine((patterns, context) => {
  patterns.forEach((pattern, index) => {
    try {
      new RegExp(pattern, "iu");
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `Invalid title regex: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}).default([]);

const promptPresetSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  extraRules: promptRuleListSchema,
});

const promptProfileOverrideSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  preset: z.string().trim().min(1).optional(),
  extraRules: promptRuleListSchema,
});

const promptRoomOverrideSchema = promptProfileOverrideSchema.extend({
  id: z.string().trim().min(1),
  match: z.object({
    titlePrefixes: promptRuleListSchema,
    titleIncludes: promptRuleListSchema,
    titleRegexes: promptRegexListSchema,
  }).refine(
    ({ titlePrefixes, titleIncludes, titleRegexes }) => (
      titlePrefixes.length > 0
      || titleIncludes.length > 0
      || titleRegexes.length > 0
    ),
    "Room match must contain at least one title prefix, included text, or regular expression",
  ),
});

const promptUserOverrideSchema = promptProfileOverrideSchema.extend({
  rooms: z.array(promptRoomOverrideSchema).default([]),
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
  roomId?: string;
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
  videoTitle?: string | null;
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
  videoTitle = null,
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
  const roomOverride = userOverride?.rooms.find((room) => matchesRoomTitle(room.match, videoTitle));
  const presetName = roomOverride?.preset ?? userOverride?.preset;
  const preset = presetName ? config.presets[presetName] : undefined;

  if (presetName && !preset) {
    const roomContext = roomOverride ? ` room "${roomOverride.id}"` : "";
    throw new Error(`Unknown summary prompt preset "${presetName}" for user ${ownerKey}${roomContext}`);
  }

  return {
    ownerMid: normalizeOwnerMid(ownerMid),
    displayName: roomOverride?.displayName
      ?? userOverride?.displayName
      ?? preset?.displayName
      ?? config.defaults.displayName,
    preset: presetName,
    roomId: roomOverride?.id,
    extraRules: [
      ...config.defaults.extraRules,
      ...(preset?.extraRules ?? []),
      ...(userOverride?.extraRules ?? []),
      ...(roomOverride?.extraRules ?? []),
    ],
  };
}

function matchesRoomTitle(
  match: {
    titlePrefixes: string[];
    titleIncludes: string[];
    titleRegexes: string[];
  },
  videoTitle: unknown,
): boolean {
  const normalizedTitle = String(videoTitle ?? "").trim();
  if (!normalizedTitle) {
    return false;
  }

  return match.titlePrefixes.some((prefix) => normalizedTitle.startsWith(prefix))
    || match.titleIncludes.some((text) => normalizedTitle.includes(text))
    || match.titleRegexes.some((pattern) => new RegExp(pattern, "iu").test(normalizedTitle));
}

function normalizeOwnerMid(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeOwnerMidKey(value: unknown): string {
  const normalized = normalizeOwnerMid(value);
  return normalized ? String(normalized) : "";
}
