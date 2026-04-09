import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, runCommand } from "./runtime-tools.mjs";

export async function runPipelineForBvid({
  cookieFile,
  dbPath,
  workRoot,
  bvid,
  publish = true,
  runCommandImpl = runCommand,
  repoRoot = getRepoRoot(),
} = {}) {
  const scriptPath = path.join(repoRoot, "scripts", "run-video-pipeline.mjs");
  const args = [
    scriptPath,
    "--cookie-file",
    path.resolve(repoRoot, cookieFile),
    "--bvid",
    bvid,
    "--db",
    path.resolve(repoRoot, dbPath),
    "--work-root",
    workRoot,
  ];
  if (publish) {
    args.push("--publish");
  }
  const result = await runCommandImpl(process.execPath, args, {
    streamOutput: true,
    outputStream: process.stderr,
  });

  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      ok: result.code === 0,
      rawStdout: result.stdout.trim(),
    };
  }
}

export function readCookieString(cookieFile, { repoRoot = getRepoRoot(), readFileSync = fs.readFileSync } = {}) {
  const resolvedPath = path.resolve(repoRoot, cookieFile);
  return readFileSync(resolvedPath, "utf8").trim();
}
