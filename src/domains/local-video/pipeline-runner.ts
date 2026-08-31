import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getVideoByIdentity,
  listAllVideoParts,
  listVideoParts,
  openDatabase,
  runInTransaction,
  upsertVideo,
  upsertVideoPart,
} from "../../infra/db/index";
import type { Db, VideoRecord } from "../../infra/db/index";
import { createPipelineEventLogger } from "../pipeline/event-logger";
import { runGenerationStage } from "../pipeline/generation-stage";
import { createProgressReporter } from "../pipeline/progress";
import { resolveSummaryConfig } from "../summary/index";
import { savePartSubtitle } from "../../infra/db/index";
import { transcribeWithRetries } from "../subtitle/transcriber";
import { createWorkFileLogger } from "../../shared/logger";
import { getRepoRoot, runCommand } from "../../shared/runtime-tools";
import { buildVideoWorkDirName, ensureVideoWorkDir } from "../../shared/work-paths";
import { withVideoPipelineLock } from "../video/pipeline-lock";

const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

interface LocalPipelineArgs extends Record<string, unknown> {
  ["input-dir"]?: string;
  title?: string;
  id?: string;
  db?: string;
  ["work-root"]?: string;
  ["venv-path"]?: string;
  asr?: string;
  ["force-summary"]?: boolean;
}

interface LocalVideoFile {
  absolutePath: string;
  storedPath: string;
  fileName: string;
  stem: string;
  durationSec: number;
  cid: number;
}

export async function runLocalVideoPipeline(args: LocalPipelineArgs) {
  const repoRoot = getRepoRoot();
  const inputDir = resolveInputDir(args["input-dir"], repoRoot);
  const files = await inspectLocalVideoFiles(inputDir, repoRoot);
  const title = String(args.title ?? "").trim() || deriveGroupTitle(files);
  const localKey = String(args.id ?? "").trim() || toPortablePath(inputDir, repoRoot);
  const identity = buildLocalIdentity(localKey);
  const dbPath = String(args.db ?? "work/pipeline.sqlite3");
  const workRoot = String(args["work-root"] ?? "work");
  const venvPath = String(args["venv-path"] ?? ".3.11");
  const asr = String(args.asr ?? "funasr");
  const db = openDatabase(dbPath);

  try {
    return await withVideoPipelineLock({
      workRoot,
      bvid: identity.bvid,
      videoTitle: title,
      publishRequested: false,
    }, async () => {
      const video = syncLocalVideoToDb(db, {
        ...identity,
        title,
        files,
      });
      const logger = createWorkFileLogger({
        workRoot,
        name: "pipeline",
        label: video.work_dir_name || video.bvid,
        context: {
          scope: "pipeline",
          bvid: video.bvid,
          aid: video.aid,
          videoTitle: video.title,
          sourceType: "local",
        },
      });
      const eventLogger = createPipelineEventLogger({
        db,
        video,
        logger,
      });
      const summaryConfig = resolveSummaryConfig(args);
      const forceSummary = Boolean(args["force-summary"]);
      const parts = listVideoParts(db, video.id);
      const pendingCount = forceSummary
        ? parts.length
        : parts.filter((part) => !String(part.summary_text ?? "").trim()).length;
      const progress = createProgressReporter(video, pendingCount, {
        logger,
      });

      eventLogger.log({
        scope: "pipeline",
        action: "run",
        status: "started",
        message: `Local pipeline started for ${video.bvid}`,
        details: {
          inputDir,
          sourceFiles: files.map((file) => file.storedPath),
          publishEnabled: false,
          forceSummary,
        },
      });

      try {
        const generation = await runGenerationStage({
          client: null,
          db,
          video,
          summaryOwnerMid: null,
          summaryOwnerName: title,
          cookie: "",
          workRoot,
          venvPath,
          asr,
          summaryConfig,
          forceSummary,
          eventLogger,
          progress,
          ensureSubtitleForPartImpl: (options) => ensureLocalSubtitleForPart({
            db: options.db,
            video: options.video ?? video,
            videoId: options.videoId,
            bvid: options.bvid,
            videoTitle: options.videoTitle ?? video.title,
            pageNo: options.pageNo,
            cid: options.cid,
            partTitle: options.partTitle ?? "",
            durationSec: options.durationSec ?? 0,
            sourcePath: getSourcePathForPart(db, video.id, options.cid, repoRoot),
            workRoot: options.workRoot ?? workRoot,
            venvPath: options.venvPath ?? venvPath,
            asr: options.asr ?? asr,
            progress: options.progress,
            eventLogger: options.eventLogger,
          }),
        });

        eventLogger.log({
          scope: "publish",
          action: "comment-thread",
          status: "skipped",
          message: "Local videos are not publishable",
        });
        eventLogger.log({
          scope: "pipeline",
          action: "run",
          status: "succeeded",
          message: `Local pipeline completed for ${video.bvid}`,
          details: {
            generatedPages: generation.summaryResults.map((item) => item.pageNo),
            publishEnabled: false,
          },
        });

        return {
          ok: true,
          dbPath,
          inputDir,
          video: {
            id: video.id,
            localId: video.bvid,
            title: video.title,
            pageCount: video.page_count,
            sourceType: video.source_type,
            publishEnabled: Boolean(video.publish_enabled),
          },
          sourceFiles: files.map((file, index) => ({
            pageNo: index + 1,
            path: file.storedPath,
            durationSec: file.durationSec,
          })),
          generatedPages: generation.summaryResults.map((item) => item.pageNo),
          subtitleResults: generation.subtitleResults,
          summaryResults: generation.summaryResults,
          artifacts: generation.artifacts,
        };
      } catch (error) {
        eventLogger.log({
          scope: "pipeline",
          action: "run",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  } finally {
    db.close();
  }
}

function syncLocalVideoToDb(
  db: Db,
  input: {
    bvid: string;
    aid: number;
    title: string;
    files: LocalVideoFile[];
  },
): VideoRecord {
  const existingVideo = getVideoByIdentity(db, {
    bvid: input.bvid,
    aid: input.aid,
  });
  const previousParts = existingVideo ? listAllVideoParts(db, existingVideo.id) : [];
  const previousByCid = new Map(previousParts.map((part) => [part.cid, part]));
  const nextCids = new Set(input.files.map((file) => file.cid));
  let videoId = existingVideo?.id ?? null;

  runInTransaction(db, () => {
    const video = upsertVideo(db, {
      bvid: input.bvid,
      aid: input.aid,
      title: input.title,
      ownerName: "local",
      ownerDirName: "local",
      workDirName: existingVideo?.work_dir_name ?? buildVideoWorkDirName({
        title: input.title,
        bvid: input.bvid,
        ownerName: "local",
      }),
      sourceType: "local",
      publishEnabled: false,
      pageCount: input.files.length,
    });
    videoId = video.id;

    for (const [index, file] of input.files.entries()) {
      const pageNo = index + 1;
      const existingPart = previousByCid.get(file.cid);
      upsertVideoPart(db, {
        videoId: video.id,
        pageNo,
        cid: file.cid,
        partTitle: file.stem,
        durationSec: file.durationSec,
        sourcePath: file.storedPath,
        subtitlePath: existingPart?.subtitle_path ?? null,
        subtitleSource: existingPart?.subtitle_source ?? null,
        subtitleLang: existingPart?.subtitle_lang ?? null,
        subtitleText: existingPart?.subtitle_text ?? null,
        promptText: existingPart?.prompt_text ?? null,
        summaryText: existingPart?.summary_text ?? null,
        processedSummaryText: existingPart?.summary_text_processed ?? null,
        summaryHash: existingPart?.summary_hash ?? null,
        published: false,
        isDeleted: false,
      });
    }

    for (const previousPart of previousParts) {
      if (nextCids.has(previousPart.cid)) {
        continue;
      }

      upsertVideoPart(db, {
        videoId: video.id,
        pageNo: previousPart.page_no,
        cid: previousPart.cid,
        partTitle: previousPart.part_title,
        durationSec: previousPart.duration_sec,
        sourcePath: previousPart.source_path,
        subtitlePath: previousPart.subtitle_path,
        subtitleSource: previousPart.subtitle_source,
        subtitleLang: previousPart.subtitle_lang,
        subtitleText: previousPart.subtitle_text,
        promptText: previousPart.prompt_text,
        summaryText: previousPart.summary_text,
        processedSummaryText: previousPart.summary_text_processed,
        summaryHash: previousPart.summary_hash,
        published: false,
        isDeleted: true,
        deletedAt: new Date().toISOString(),
      });
    }
  });

  if (!videoId) {
    throw new Error(`Failed to store local video ${input.bvid}`);
  }

  const video = getVideoByIdentity(db, {
    bvid: input.bvid,
    aid: input.aid,
  });
  if (!video) {
    throw new Error(`Failed to reload local video ${input.bvid}`);
  }
  return video;
}

async function ensureLocalSubtitleForPart({
  db,
  video,
  videoId,
  bvid,
  videoTitle,
  pageNo,
  cid,
  partTitle,
  durationSec,
  sourcePath,
  workRoot,
  venvPath,
  asr,
  progress,
  eventLogger,
}: {
  db: Db;
  video: VideoRecord;
  videoId: number;
  bvid: string;
  videoTitle: string;
  pageNo: number;
  cid: number;
  partTitle: string;
  durationSec: number;
  sourcePath: string;
  workRoot: string;
  venvPath: string;
  asr: string;
  progress: Record<string, any> | null;
  eventLogger: { log?: (event: Record<string, unknown>) => unknown } | null;
}) {
  const absoluteSourcePath = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(getRepoRoot(), sourcePath);
  if (!fs.existsSync(absoluteSourcePath)) {
    throw new Error(`Local source file not found: ${absoluteSourcePath}`);
  }

  const workDir = ensureVideoWorkDir({
    db,
    video,
    workRoot,
  });
  const stableBaseName = `cid-${Math.abs(cid)}`;
  const subtitlePath = path.join(workDir, `${stableBaseName}.srt`);
  const audioPath = path.join(workDir, `${stableBaseName}.m4a`);

  if (fs.existsSync(subtitlePath)) {
    const subtitleText = fs.readFileSync(subtitlePath, "utf8").trim();
    if (subtitleText) {
      savePartSubtitle(db, videoId, pageNo, {
        subtitlePath,
        subtitleSource: "local_asr",
        subtitleLang: "zh",
        subtitleText,
      });
      return {
        subtitlePath,
        subtitleSource: "local_asr",
        subtitleLang: "zh",
        reused: true,
        durationSec,
      };
    }
  }

  if (!fs.existsSync(audioPath)) {
    progress?.logPartStage?.(pageNo, "Subtitle", "Extracting audio from local video");
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      absoluteSourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "aac",
      audioPath,
    ], {
      streamOutput: true,
      outputStream: progress?.rawOutputStream ?? progress?.outputStream,
      logger: progress?.logger ?? null,
      logContext: {
        scope: "subtitle",
        action: "extract-local-audio",
        bvid,
        pageNo,
        cid,
        partTitle,
      },
    });
  }

  await transcribeWithRetries({
    audioPath,
    subtitlePath,
    asr,
    bvid,
    videoTitle,
    cid,
    pageNo,
    partTitle,
    workRoot,
    venvPath,
    progress,
    eventLogger,
  });

  const subtitleText = fs.readFileSync(subtitlePath, "utf8").trim();
  savePartSubtitle(db, videoId, pageNo, {
    subtitlePath,
    subtitleSource: "local_asr",
    subtitleLang: "zh",
    subtitleText,
  });
  return {
    subtitlePath,
    subtitleSource: "local_asr",
    subtitleLang: "zh",
    reused: false,
    durationSec,
  };
}

function getSourcePathForPart(db: Db, videoId: number, cid: number, repoRoot: string): string {
  const part = listVideoParts(db, videoId).find((candidate) => candidate.cid === cid);
  const sourcePath = String(part?.source_path ?? "").trim();
  if (!sourcePath) {
    throw new Error(`Missing local source path for cid ${cid}`);
  }
  return path.isAbsolute(sourcePath) ? sourcePath : path.resolve(repoRoot, sourcePath);
}

async function inspectLocalVideoFiles(inputDir: string, repoRoot: string): Promise<LocalVideoFile[]> {
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`Local input directory does not exist: ${inputDir}`);
  }

  const paths = fs.readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), "zh-CN"));
  if (paths.length === 0) {
    throw new Error(`No supported video files found in ${inputDir}`);
  }

  const files: LocalVideoFile[] = [];
  for (const absolutePath of paths) {
    const storedPath = toPortablePath(absolutePath, repoRoot);
    files.push({
      absolutePath,
      storedPath,
      fileName: path.basename(absolutePath),
      stem: path.basename(absolutePath, path.extname(absolutePath)),
      durationSec: await probeDurationSec(absolutePath),
      cid: buildNegativeId(`part:${storedPath}`),
    });
  }
  return files;
}

async function probeDurationSec(videoPath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Unable to read video duration: ${videoPath}`);
  }
  return Math.round(duration);
}

function resolveInputDir(value: unknown, repoRoot: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("Missing required option: --input-dir");
  }
  return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(repoRoot, normalized);
}

function buildLocalIdentity(localKey: string) {
  const digest = crypto.createHash("sha1").update(localKey).digest("hex");
  return {
    bvid: `LOCAL_${digest.slice(0, 16).toUpperCase()}`,
    aid: buildNegativeId(`video:${localKey}`),
  };
}

function buildNegativeId(value: string): number {
  const digest = crypto.createHash("sha1").update(value).digest("hex").slice(0, 13);
  return -(Number.parseInt(digest, 16) + 1);
}

function deriveGroupTitle(files: LocalVideoFile[]): string {
  const stems = files.map((file) => file.stem);
  if (stems.length === 1) {
    return stems[0];
  }

  let prefix = stems[0];
  for (const stem of stems.slice(1)) {
    let length = 0;
    while (length < prefix.length && length < stem.length && prefix[length] === stem[length]) {
      length += 1;
    }
    prefix = prefix.slice(0, length);
  }

  return prefix.replace(/[\s._-]+$/u, "").trim() || path.basename(path.dirname(files[0].absolutePath));
}

function toPortablePath(targetPath: string, repoRoot: string): string {
  const relativePath = path.relative(repoRoot, targetPath);
  const isInsideRepo = relativePath
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
  return (isInsideRepo ? relativePath : path.resolve(targetPath)).replace(/\\/g, "/");
}
