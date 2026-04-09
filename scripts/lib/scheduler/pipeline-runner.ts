import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, runCommand } from "../shared/runtime-tools.js";
import type { CommandResult, RunCommandOptions } from "../shared/runtime-tools.js";

export interface PipelineProcessResult extends Record<string, unknown> {
  ok?: boolean;
  rawStdout?: string;
  generatedPages?: number[];
  reusedSummaryFrom?: unknown;
}

interface RunPipelineForBvidOptions {
  cookieFile: string;
  dbPath: string;
  workRoot: string;
  bvid: string;
  publish?: boolean;
  runCommandImpl?: (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandResult>;
  repoRoot?: string;
}

export async function runPipelineForBvid({
  cookieFile,
  dbPath,
  workRoot,
  bvid,
  publish = true,
  runCommandImpl = runCommand,
  repoRoot = getRepoRoot(),
}: RunPipelineForBvidOptions): Promise<PipelineProcessResult> {
  const scriptPath = path.join(repoRoot, "scripts", "commands", "run-video-pipeline.ts");
  const args = [
    "--import",
    "tsx",
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

export function readCookieString(
  cookieFile: string,
  {
    repoRoot = getRepoRoot(),
    readFileSync = fs.readFileSync as (filePath: string, encoding: BufferEncoding) => string,
  }: {
    repoRoot?: string;
    readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
  } = {},
): string {
  const resolvedPath = path.resolve(repoRoot, cookieFile);
  return readFileSync(resolvedPath, "utf8").trim();
}
