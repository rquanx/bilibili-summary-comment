import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { firstNonEmptyString } from "./utils";

export const DEFAULT_FASTER_WHISPER_MODEL_NAME = "large-v3-turbo";

type FileStatLike = Pick<fs.Stats, "isFile" | "isDirectory">;
type StatSyncFn = (filePath: string) => FileStatLike;

interface FasterWhisperEnv extends Record<string, string | undefined> {
  VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH?: string;
  VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN?: string;
  VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_DEVICE?: string;
  VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_COMPUTE_TYPE?: string;
  LOCALAPPDATA?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
}

let cachedNvidiaGpuNames: string[] | null = null;

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
    env.XDG_DATA_HOME
      ? path.join(env.XDG_DATA_HOME, "VideoCaptioner", "models", "faster-whisper-large-v3-turbo")
      : null,
    env.HOME
      ? path.join(env.HOME, ".local", "share", "VideoCaptioner", "models", "faster-whisper-large-v3-turbo")
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
  statSync = fs.statSync,
}: {
  env?: FasterWhisperEnv;
  existsSync?: (filePath: string) => boolean;
  statSync?: StatSyncFn;
} = {}) {
  const candidates = buildLocalFasterWhisperExecutableDirCandidates(env);

  for (const candidate of candidates) {
    const programPath = findFasterWhisperProgramInDir(candidate, existsSync, statSync);
    if (!programPath) {
      continue;
    }

    const candidatePath = path.resolve(candidate);
    const candidateDir = isDirectFasterWhisperProgramPath(candidatePath, statSync) ? path.dirname(candidatePath) : candidatePath;
    const pathEntries = [path.dirname(programPath)];
    if (path.dirname(programPath) !== candidateDir) {
      pathEntries.push(candidateDir);
    }

    return {
      device: inferFasterWhisperDevice(programPath, env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_DEVICE),
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
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "VideoCaptioner", "resource", "bin", "Faster-Whisper-XXL") : null,
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "VideoCaptioner", "resource", "bin") : null,
    env.HOME ? path.join(env.HOME, ".local", "share", "VideoCaptioner", "resource", "bin", "Faster-Whisper-XXL") : null,
    env.HOME ? path.join(env.HOME, ".local", "share", "VideoCaptioner", "resource", "bin") : null,
    "/opt/videocaptioner/bin/Faster-Whisper-XXL",
    "/opt/videocaptioner/bin",
    "/usr/local/bin",
  ]);
}

export function findFasterWhisperProgramInDir(
  directory: string | null | undefined,
  existsSync: (filePath: string) => boolean = fs.existsSync,
  statSync: StatSyncFn = fs.statSync,
): string | null {
  if (!directory || !existsSync(directory)) {
    return null;
  }

  if (isDirectFasterWhisperProgramPath(directory, statSync)) {
    return path.resolve(directory);
  }

  const programCandidates = [
    path.join(directory, "faster-whisper-xxl.exe"),
    path.join(directory, "faster-whisper-xxl"),
    path.join(directory, "faster-whisper.exe"),
    path.join(directory, "faster-whisper"),
    path.join(directory, "faster_whisper.exe"),
    path.join(directory, "faster_whisper"),
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

export function inferFasterWhisperDevice(programPath: string | null | undefined, configuredDevice?: string | null): string {
  const normalizedConfiguredDevice = String(configuredDevice ?? "").trim().toLowerCase();
  if (normalizedConfiguredDevice === "cpu" || normalizedConfiguredDevice === "cuda" || normalizedConfiguredDevice === "auto") {
    return normalizedConfiguredDevice;
  }

  const normalizedPath = String(programPath ?? "").toLowerCase();
  return normalizedPath.includes("faster-whisper-xxl") ? "cuda" : "cpu";
}

export function resolveDirectFasterWhisperComputeType({
  device,
  env = process.env,
  readGpuNamesImpl = readNvidiaGpuNames,
}: {
  device: string | null | undefined;
  env?: FasterWhisperEnv;
  readGpuNamesImpl?: () => string[];
}): string | null {
  const normalizedConfiguredComputeType = String(env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_COMPUTE_TYPE ?? "").trim().toLowerCase();
  if (normalizedConfiguredComputeType) {
    return normalizedConfiguredComputeType;
  }

  if (String(device ?? "").trim().toLowerCase() !== "cuda") {
    return null;
  }

  const gpuNames = readGpuNamesImpl();
  if (gpuNames.some(isNvidiaRtx50SeriesGpuName)) {
    return "float32";
  }

  return "float16";
}

function uniqueNonEmptyPaths(candidates: Array<string | null | undefined>): string[] {
  return [...new Set(candidates.filter((candidate) => typeof candidate === "string" && candidate.trim()))];
}

function readNvidiaGpuNames(): string[] {
  if (cachedNvidiaGpuNames) {
    return cachedNvidiaGpuNames;
  }

  try {
    const stdout = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    cachedNvidiaGpuNames = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    cachedNvidiaGpuNames = [];
  }

  return cachedNvidiaGpuNames;
}

function isNvidiaRtx50SeriesGpuName(value: string): boolean {
  return /\brtx\s+50\d{2}\b/i.test(String(value ?? ""));
}

function isFasterWhisperProgramPathName(targetPath: string): boolean {
  const baseName = path.basename(targetPath).toLowerCase();
  return new Set([
    "faster-whisper-xxl.exe",
    "faster-whisper-xxl",
    "faster-whisper.exe",
    "faster-whisper",
    "faster_whisper.exe",
    "faster_whisper",
  ]).has(baseName);
}

function isDirectFasterWhisperProgramPath(
  targetPath: string,
  statSync: StatSyncFn,
): boolean {
  if (!isFasterWhisperProgramPathName(targetPath)) {
    return false;
  }

  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}
