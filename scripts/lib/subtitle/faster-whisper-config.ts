import fs from "node:fs";
import path from "node:path";
import { firstNonEmptyString } from "./utils.js";

export const DEFAULT_FASTER_WHISPER_MODEL_NAME = "large-v3-turbo";

interface FasterWhisperEnv extends Record<string, string | undefined> {
  VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH?: string;
  VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN?: string;
  LOCALAPPDATA?: string;
}

export function resolveLocalFasterWhisperConfig({
  env = process.env,
  existsSync = fs.existsSync,
}: {
  env?: FasterWhisperEnv;
  existsSync?: (filePath: string) => boolean;
} = {}) {
  const candidates = buildLocalFasterWhisperModelPathCandidates(env);
  const configuredPath = candidates[0] ?? null;
  if (!configuredPath) {
    return null;
  }

  const resolvedPath = path.resolve(configuredPath);
  const baseName = path.basename(resolvedPath);
  const inferredModelName = inferFasterWhisperModelName(baseName);
  const isModelDirectory = /^faster-whisper-/i.test(baseName) || inferredModelName === baseName.toLowerCase();

  return {
    modelPath: resolvedPath,
    modelDir: isModelDirectory ? path.dirname(resolvedPath) : resolvedPath,
    modelName: inferredModelName,
    exists: existsSync(resolvedPath),
  };
}

export function buildLocalFasterWhisperModelPathCandidates(env: FasterWhisperEnv = process.env): string[] {
  return uniqueNonEmptyPaths([
    firstNonEmptyString(env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH),
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, "VideoCaptioner", "AppData", "models", "faster-whisper-large-v3-turbo")
      : null,
  ]);
}

export function inferFasterWhisperModelName(value: unknown): string {
  const normalizedValue = String(value ?? "").trim().toLowerCase();
  const supportedModels = new Set([
    "tiny",
    "base",
    "small",
    "medium",
    "large-v1",
    "large-v2",
    "large-v3",
    "large-v3-turbo",
  ]);

  if (supportedModels.has(normalizedValue)) {
    return normalizedValue;
  }

  const prefixedMatch = /^faster-whisper-(.+)$/.exec(normalizedValue);
  if (prefixedMatch && supportedModels.has(prefixedMatch[1])) {
    return prefixedMatch[1];
  }

  return DEFAULT_FASTER_WHISPER_MODEL_NAME;
}

export function resolveLocalFasterWhisperExecutableConfig({
  env = process.env,
  existsSync = fs.existsSync,
}: {
  env?: FasterWhisperEnv;
  existsSync?: (filePath: string) => boolean;
} = {}) {
  const candidates = buildLocalFasterWhisperExecutableDirCandidates(env);

  for (const directory of candidates) {
    const programPath = findFasterWhisperProgramInDir(directory, existsSync);
    if (!programPath) {
      continue;
    }

    const pathEntries = [path.dirname(programPath)];
    if (path.dirname(programPath) !== directory) {
      pathEntries.push(directory);
    }

    return {
      device: inferFasterWhisperDevice(programPath),
      programPath,
      pathEntries,
    };
  }

  return null;
}

export function buildLocalFasterWhisperExecutableDirCandidates(env: FasterWhisperEnv = process.env): string[] {
  return uniqueNonEmptyPaths([
    firstNonEmptyString(env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "VideoCaptioner", "resource", "bin", "Faster-Whisper-XXL") : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "VideoCaptioner", "resource", "bin") : null,
  ]);
}

export function findFasterWhisperProgramInDir(
  directory: string | null | undefined,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): string | null {
  if (!directory || !existsSync(directory)) {
    return null;
  }

  const programCandidates = [
    path.join(directory, "faster-whisper-xxl.exe"),
    path.join(directory, "faster-whisper.exe"),
    path.join(directory, "faster_whisper.exe"),
  ];

  for (const programPath of programCandidates) {
    if (existsSync(programPath)) {
      return programPath;
    }
  }

  return null;
}

export function prependPathEntries(existingPath: string | undefined, entries: string[] | undefined): string {
  const cleanedEntries = Array.isArray(entries)
    ? entries.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const existingEntries = String(existingPath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry.trim());

  return [...new Set([...cleanedEntries, ...existingEntries])].join(path.delimiter);
}

export function inferFasterWhisperDevice(programPath: string | null | undefined): string {
  const normalizedPath = String(programPath ?? "").toLowerCase();
  return normalizedPath.includes("faster-whisper-xxl") ? "cuda" : "cpu";
}

function uniqueNonEmptyPaths(candidates: Array<string | null | undefined>): string[] {
  return [...new Set(candidates.filter((candidate) => typeof candidate === "string" && candidate.trim()))];
}
