import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../shared/runtime-tools";

export function resolveAuthFileForUser(
  authFile: string,
  userIndex: number,
  {
    repoRoot = getRepoRoot(),
    existsSync = fs.existsSync,
  }: {
    repoRoot?: string;
    existsSync?: (targetPath: fs.PathLike) => boolean;
  } = {},
): string {
  const resolvedPath = findAuthFileForUser(authFile, userIndex, {
    repoRoot,
    existsSync,
  });

  if (resolvedPath) {
    return resolvedPath;
  }

  throw new Error(`Missing auth file for summary user #${normalizeUserIndex(userIndex)}. Tried: ${buildAuthFileCandidates(authFile, userIndex, { repoRoot }).join(", ")}`);
}

export function findAuthFileForUser(
  authFile: string,
  userIndex: number,
  {
    repoRoot = getRepoRoot(),
    existsSync = fs.existsSync,
  }: {
    repoRoot?: string;
    existsSync?: (targetPath: fs.PathLike) => boolean;
  } = {},
): string | null {
  const candidates = buildAuthFileCandidates(authFile, userIndex, { repoRoot });
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function buildAuthFileCandidates(
  authFile: string,
  userIndex: number,
  {
    repoRoot = getRepoRoot(),
  }: {
    repoRoot?: string;
  } = {},
): string[] {
  const resolvedBaseFile = path.resolve(repoRoot, authFile);
  const normalizedIndex = normalizeUserIndex(userIndex);
  const parsedPath = path.parse(resolvedBaseFile);

  return uniquePaths([
    path.join(parsedPath.dir, `${parsedPath.name}_${normalizedIndex}${parsedPath.ext}`),
    path.join(parsedPath.dir, `${parsedPath.name}_1${parsedPath.ext}`),
    resolvedBaseFile,
  ]);
}

function normalizeUserIndex(userIndex: number): number {
  const normalized = Number(userIndex);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return 1;
  }

  return normalized;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.normalize(item)))];
}
