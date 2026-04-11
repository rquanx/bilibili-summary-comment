import fs from "node:fs";
import path from "node:path";
import { buildBiliVideoUrl } from "../bili/video-url";
import { getRepoRoot, runCommand } from "../shared/runtime-tools";
import type { CommandResult, RunCommandOptions } from "../shared/runtime-tools";

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
  const scriptPath = resolvePipelineEntryScript(repoRoot);
  const args = buildNodeScriptArgs(scriptPath);
  args.push(
    "--cookie-file",
    path.resolve(repoRoot, cookieFile),
    "--bvid",
    bvid,
    "--db",
    path.resolve(repoRoot, dbPath),
    "--work-root",
    workRoot,
  );
  if (publish) {
    args.push("--publish");
  }
  let result;
  try {
    result = await runCommandImpl(process.execPath, args, {
      streamOutput: true,
      outputStream: process.stderr,
    });
  } catch (error) {
    appendVideoLinkToCommandError(error, bvid);
    throw error;
  }

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

function resolvePipelineEntryScript(repoRoot: string): string {
  const compiledEntry = path.join(repoRoot, "scripts", "commands", "run-video-pipeline.js");
  if (fs.existsSync(compiledEntry)) {
    return compiledEntry;
  }

  return path.join(repoRoot, "scripts", "commands", "run-video-pipeline.ts");
}

function buildNodeScriptArgs(scriptPath: string): string[] {
  if (scriptPath.endsWith(".ts")) {
    return ["--import", "tsx", scriptPath];
  }

  return [scriptPath];
}

function appendVideoLinkToCommandError(error: unknown, bvid: string) {
  if (!error || typeof error !== "object") {
    return;
  }

  const candidate = error as { message?: unknown; stdout?: unknown };
  const parsedPayload = parseJsonObject(candidate.stdout);
  const videoUrl = String(parsedPayload?.videoUrl ?? buildBiliVideoUrl({ bvid }) ?? "").trim();
  if (!videoUrl) {
    return;
  }

  const baseMessage = String(candidate.message ?? "Unknown error").trim() || "Unknown error";
  if (!baseMessage.includes(videoUrl)) {
    candidate.message = `${baseMessage} | ${videoUrl}`;
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
