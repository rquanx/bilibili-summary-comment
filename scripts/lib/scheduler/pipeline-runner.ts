import fs from "node:fs";
import path from "node:path";
import { buildBiliVideoUrl } from "../bili/video-url";
import { getRepoRoot, runCommand } from "../shared/runtime-tools";
import { createCompositeWriteStream } from "../shared/logger";
import type { CommandResult, RunCommandOptions } from "../shared/runtime-tools";
import type { FileLogger } from "../shared/logger";

export interface PipelineProcessResult extends Record<string, unknown> {
  ok?: boolean;
  rawStdout?: string;
  generatedPages?: number[];
  reusedSummaryFrom?: unknown;
}

interface PipelineFailurePayload extends Record<string, unknown> {
  failedStep?: unknown;
  failedScope?: unknown;
  failedAction?: unknown;
  pageNo?: unknown;
  cid?: unknown;
  videoUrl?: unknown;
}

interface RunPipelineForBvidOptions {
  authFile?: string | null;
  cookieFile?: string | null;
  dbPath: string;
  workRoot: string;
  bvid: string;
  logDay?: string | null;
  logGroup?: string | null;
  publish?: boolean;
  logger?: FileLogger | null;
  runCommandImpl?: (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandResult>;
  repoRoot?: string;
}

export async function runPipelineForBvid({
  authFile = null,
  cookieFile,
  dbPath,
  workRoot,
  bvid,
  logDay = null,
  logGroup = null,
  publish = true,
  logger = null,
  runCommandImpl = runCommand,
  repoRoot = getRepoRoot(),
}: RunPipelineForBvidOptions): Promise<PipelineProcessResult> {
  const scriptPath = resolvePipelineEntryScript(repoRoot);
  const args = buildNodeScriptArgs(scriptPath);
  if (authFile) {
    args.push("--auth-file", path.resolve(repoRoot, authFile));
  }
  if (cookieFile) {
    args.push("--cookie-file", path.resolve(repoRoot, cookieFile));
  }
  args.push("--bvid", bvid, "--db", path.resolve(repoRoot, dbPath), "--work-root", workRoot);
  if (publish) {
    args.push("--publish");
  }
  let result;
  try {
    const stdoutLogStream = logger?.createStream({
      level: "debug",
      scope: "pipeline-child",
      bvid,
      channel: "stdout",
    }) ?? null;
    const stderrLogStream = logger?.createStream({
      level: "debug",
      scope: "pipeline-child",
      bvid,
      channel: "stderr",
    }) ?? null;
    result = await runCommandImpl(process.execPath, args, {
      env: {
        PIPELINE_LOG_DAY: logDay ?? "",
        PIPELINE_LOG_GROUP: logGroup ?? "",
      },
      streamOutput: true,
      stdoutStream: stdoutLogStream,
      stderrStream: createCompositeWriteStream(process.stderr, stderrLogStream),
      logger,
      logContext: {
        scope: "scheduler",
        action: "run-pipeline",
        bvid,
      },
    });
  } catch (error) {
    appendPipelineFailureContextToCommandError(error, bvid);
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

function appendPipelineFailureContextToCommandError(error: unknown, bvid: string) {
  if (!error || typeof error !== "object") {
    return;
  }

  const candidate = error as {
    message?: unknown;
    stdout?: unknown;
    failedStep?: unknown;
    failedScope?: unknown;
    failedAction?: unknown;
    pageNo?: unknown;
    cid?: unknown;
    videoUrl?: unknown;
  };
  const parsedPayload = parseJsonObject(candidate.stdout) as PipelineFailurePayload | null;
  const baseMessage = String(candidate.message ?? "Unknown error").trim() || "Unknown error";
  const failureContext = buildFailureContext(parsedPayload);
  const videoUrl = String(parsedPayload?.videoUrl ?? buildBiliVideoUrl({ bvid }) ?? "").trim();

  if (failureContext && !baseMessage.includes(failureContext)) {
    candidate.message = `${baseMessage} | ${failureContext}`;
  } else {
    candidate.message = baseMessage;
  }

  if (videoUrl && !String(candidate.message ?? "").includes(videoUrl)) {
    candidate.message = `${candidate.message} | ${videoUrl}`;
  }

  if (parsedPayload?.failedStep !== undefined) {
    candidate.failedStep = parsedPayload.failedStep;
  }

  if (parsedPayload?.failedScope !== undefined) {
    candidate.failedScope = parsedPayload.failedScope;
  }

  if (parsedPayload?.failedAction !== undefined) {
    candidate.failedAction = parsedPayload.failedAction;
  }

  if (parsedPayload?.pageNo !== undefined) {
    candidate.pageNo = parsedPayload.pageNo;
  }

  if (parsedPayload?.cid !== undefined) {
    candidate.cid = parsedPayload.cid;
  }

  if (videoUrl) {
    candidate.videoUrl = videoUrl;
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

function buildFailureContext(payload: PipelineFailurePayload | null): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const step = formatFailureStep(payload);
  const pageNo = normalizePositiveInteger(payload.pageNo);
  const parts = [];

  if (step) {
    parts.push(`step=${step}`);
  }

  if (pageNo !== null) {
    parts.push(`page=P${pageNo}`);
  }

  return parts.join(", ");
}

function formatFailureStep(payload: PipelineFailurePayload): string {
  const explicitStep = String(payload.failedStep ?? "").trim();
  if (explicitStep) {
    return explicitStep;
  }

  const scope = String(payload.failedScope ?? "").trim();
  const action = String(payload.failedAction ?? "").trim();
  if (scope && action) {
    return `${scope}/${action}`;
  }

  return scope || action;
}

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}
