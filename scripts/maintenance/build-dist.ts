import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const distRoot = path.join(repoRoot, "dist");
const buildConfigPath = path.join(repoRoot, "tsconfig.build.json");
const typeScriptCliPath = path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js");

const STATIC_RUNTIME_ASSETS = [
  ".env",
  "cookie.txt",
  "bili-auth.json",
  "work/bili-auth.json",
  "work/pipeline.sqlite3",
  "sql",
];

main();

function main() {
  cleanDistDirectory();
  runTypeScriptBuild();
  const copiedAssets = copyRuntimeAssets();

  process.stdout.write(`Build completed: ${path.relative(repoRoot, distRoot) || "dist"}\n`);
  if (copiedAssets.length > 0) {
    process.stdout.write(`Copied assets:\n${copiedAssets.map((item) => `- ${item}`).join("\n")}\n`);
  }
}

function cleanDistDirectory() {
  fs.rmSync(distRoot, { recursive: true, force: true });
  fs.mkdirSync(distRoot, { recursive: true });
}

function runTypeScriptBuild() {
  const result = spawnSync(process.execPath, [typeScriptCliPath, "-p", buildConfigPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function copyRuntimeAssets(): string[] {
  const envConfig = readDotEnvConfig();
  const copiedAssets: string[] = [];
  const assetCandidates = uniqueStrings([
    ...STATIC_RUNTIME_ASSETS,
    envConfig.BILI_COOKIE_FILE,
    envConfig.BILI_AUTH_FILE,
    envConfig.PIPELINE_DB_PATH,
  ]);

  for (const asset of assetCandidates) {
    const resolvedSource = resolveRepoAssetPath(asset);
    if (!resolvedSource || !fs.existsSync(resolvedSource)) {
      continue;
    }

    const relativeTarget = path.relative(repoRoot, resolvedSource);
    if (!relativeTarget || relativeTarget.startsWith("..")) {
      continue;
    }

    const destination = path.join(distRoot, relativeTarget);
    copyPath(resolvedSource, destination);
    copiedAssets.push(toPosixPath(relativeTarget));
  }

  return copiedAssets.sort();
}

function readDotEnvConfig(): Record<string, string> {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  return parseDotEnv(fs.readFileSync(envPath, "utf8"));
}

function resolveRepoAssetPath(assetPath: string | undefined): string | null {
  const normalized = String(assetPath ?? "").trim();
  if (!normalized) {
    return null;
  }

  const resolvedPath = path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(repoRoot, normalized);
  if (!isPathInsideRepo(resolvedPath)) {
    return null;
  }

  return resolvedPath;
}

function isPathInsideRepo(targetPath: string): boolean {
  const relativePath = path.relative(repoRoot, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function copyPath(source: string, destination: string) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    force: true,
    recursive: true,
  });
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function toPosixPath(targetPath: string): string {
  return targetPath.split(path.sep).join("/");
}
