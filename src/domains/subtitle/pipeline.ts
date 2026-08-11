import fs from "node:fs";
import path from "node:path";
import { ensureVideoWorkDir } from "../../shared/work-paths";
import { runVenvModule } from "../../shared/runtime-tools";
import type { CommandError } from "../../shared/runtime-tools";
import { getVideoById, getVideoPartByCid, savePartSubtitle } from "../../infra/db/index";
import type { Db } from "../../infra/db/index";
import { findReusableSubtitleSource } from "../summary/live-session-reuse";
import { tryDownloadBiliSubtitle } from "./bili";
import { ensureYtDlpCookieFile } from "./cookie-file";
import { inspectSubtitleQuality } from "./quality";
import { transcribeWithRetries } from "./transcriber";
import { formatErrorMessage } from "./utils";

interface SubtitleFinalizeInput {
  db: Db;
  videoId: number;
  pageNo: number;
  cid: number;
  partTitle: string;
  eventLogger: { log?: (event: Record<string, unknown>) => void } | null;
  subtitlePath: string;
  subtitleSource: string;
  subtitleLang: string | null;
  reused: boolean;
  durationSec?: number;
}

export async function ensureSubtitleForPart({
  client,
  db,
  video = null,
  videoId,
  bvid,
  videoTitle = "",
  pageNo,
  cid,
  partTitle = "",
  existingSubtitlePath = null,
  cookie,
  cookieFile = null,
  durationSec = 0,
  workRoot = "work",
  venvPath = ".3.11",
  asr = "funasr",
  progress = null,
  eventLogger = null,
  tryDownloadBiliSubtitleImpl = tryDownloadBiliSubtitle,
  transcribeWithRetriesImpl = transcribeWithRetries,
  runVenvModuleImpl = runVenvModule,
}) {
  const currentVideo = video ?? getVideoById(db, videoId) ?? {
    id: videoId,
    bvid,
    title: videoTitle,
    owner_mid: null,
    owner_name: null,
    owner_dir_name: null,
    work_dir_name: null,
  };
  const workDir = ensureVideoWorkDir({
    db,
    video: currentVideo,
    workRoot,
  });

  const stableBaseName = `cid-${String(cid)}`;
  const subtitlePath = path.join(workDir, `${stableBaseName}.srt`);
  const audioTemplate = path.join(workDir, `${stableBaseName}.%(ext)s`);
  const audioPath = path.join(workDir, `${stableBaseName}.m4a`);
  const currentPart = getVideoPartByCid(db, videoId, cid);

  if (existingSubtitlePath && fs.existsSync(existingSubtitlePath)) {
    if (path.resolve(existingSubtitlePath) !== path.resolve(subtitlePath)) {
      fs.copyFileSync(existingSubtitlePath, subtitlePath);
    }

    if (acceptSubtitleCandidate({
      subtitlePath,
      subtitleSource: "local",
      pageNo,
      cid,
      partTitle,
      eventLogger,
      progress,
    })) {
      return finalizeSubtitle({
        db,
        videoId,
        pageNo,
        cid,
        partTitle,
        eventLogger,
        subtitlePath,
        subtitleSource: "local",
        subtitleLang: null,
        reused: true,
      });
    }

    fs.rmSync(subtitlePath, { force: true });
  }

  if (fs.existsSync(subtitlePath)) {
    if (acceptSubtitleCandidate({
      subtitlePath,
      subtitleSource: "local",
      pageNo,
      cid,
      partTitle,
      eventLogger,
      progress,
    })) {
      return finalizeSubtitle({
        db,
        videoId,
        pageNo,
        cid,
        partTitle,
        eventLogger,
        subtitlePath,
        subtitleSource: "local",
        subtitleLang: null,
        reused: true,
      });
    }

    fs.rmSync(subtitlePath, { force: true });
  }

  const storedSubtitleText = String(currentPart?.subtitle_text ?? "").trim();
  if (storedSubtitleText) {
    fs.writeFileSync(subtitlePath, `${storedSubtitleText}\n`, "utf8");

    if (acceptSubtitleCandidate({
      subtitlePath,
      subtitleSource: String(currentPart?.subtitle_source ?? "").trim() || "local",
      pageNo,
      cid,
      partTitle,
      eventLogger,
      progress,
    })) {
      return finalizeSubtitle({
        db,
        videoId,
        pageNo,
        cid,
        partTitle,
        eventLogger,
        subtitlePath,
        subtitleSource: String(currentPart?.subtitle_source ?? "").trim() || "local",
        subtitleLang: currentPart?.subtitle_lang ?? null,
        reused: true,
      });
    }

    fs.rmSync(subtitlePath, { force: true });
  }

  const reusableSubtitle = findReusableSubtitleSource(
    db,
    {
      id: videoId,
      bvid,
      title: videoTitle,
    },
    {
      pageNo,
      partTitle,
    },
  );
  if (reusableSubtitle?.video) {
    ensureVideoWorkDir({
      db,
      video: reusableSubtitle.video,
      workRoot,
    });
  }
  const reusableSubtitlePart = reusableSubtitle?.part && reusableSubtitle?.video
    ? getVideoPartByCid(db, reusableSubtitle.video.id, reusableSubtitle.part.cid) ?? reusableSubtitle.part
    : reusableSubtitle?.part ?? null;
  const reusableSubtitlePath = String(reusableSubtitlePart?.subtitle_path ?? "").trim();
  if (reusableSubtitlePath && fs.existsSync(reusableSubtitlePath)) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Reusing subtitle from ${reusableSubtitle.video.bvid} P${Number(reusableSubtitle.part?.page_no ?? 0)}`,
    );

    if (path.resolve(reusableSubtitlePath) !== path.resolve(subtitlePath)) {
      fs.copyFileSync(reusableSubtitlePath, subtitlePath);
    }

    const subtitleSource = String(reusableSubtitlePart?.subtitle_source ?? "").trim() || "local";
    if (acceptSubtitleCandidate({
      subtitlePath,
      subtitleSource,
      pageNo,
      cid,
      partTitle,
      eventLogger,
      progress,
    })) {
      return finalizeSubtitle({
        db,
        videoId,
        pageNo,
        cid,
        partTitle,
        eventLogger,
        subtitlePath,
        subtitleSource,
        subtitleLang: reusableSubtitlePart?.subtitle_lang ?? null,
        reused: true,
      });
    }

    fs.rmSync(subtitlePath, { force: true });
  }
  const reusableSubtitleText = String(reusableSubtitlePart?.subtitle_text ?? "").trim();
  if (reusableSubtitleText) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Rebuilding subtitle from stored text in ${reusableSubtitle?.video?.bvid ?? "database"}`,
    );
    fs.writeFileSync(subtitlePath, `${reusableSubtitleText}\n`, "utf8");

    const subtitleSource = String(reusableSubtitlePart?.subtitle_source ?? "").trim() || "local";
    if (acceptSubtitleCandidate({
      subtitlePath,
      subtitleSource,
      pageNo,
      cid,
      partTitle,
      eventLogger,
      progress,
    })) {
      return finalizeSubtitle({
        db,
        videoId,
        pageNo,
        cid,
        partTitle,
        eventLogger,
        subtitlePath,
        subtitleSource,
        subtitleLang: reusableSubtitlePart?.subtitle_lang ?? null,
        reused: true,
      });
    }

    fs.rmSync(subtitlePath, { force: true });
  }

  progress?.logPartStage?.(pageNo, "Subtitle", "Trying Bilibili subtitle");
  let biliSubtitle = null;
  try {
    biliSubtitle = await tryDownloadBiliSubtitleImpl({
      client,
      bvid,
      cid,
      subtitlePath,
      cookie,
    });
  } catch (error) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Bilibili subtitle unavailable (${formatErrorMessage(error)}), falling back to ASR`,
    );
  }

  if (biliSubtitle) {
    if (acceptSubtitleCandidate({
      subtitlePath,
      subtitleSource: biliSubtitle.source,
      pageNo,
      cid,
      partTitle,
      eventLogger,
      progress,
    })) {
      return finalizeSubtitle({
        db,
        videoId,
        pageNo,
        cid,
        partTitle,
        eventLogger,
        subtitlePath,
        subtitleSource: biliSubtitle.source,
        subtitleLang: biliSubtitle.lang,
        reused: false,
      });
    }

    fs.rmSync(subtitlePath, { force: true });
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      "Downloaded subtitle failed quality check, falling back to ASR",
    );
  }

  if (!fs.existsSync(audioPath)) {
    progress?.logPartStage?.(pageNo, "Subtitle", "Downloading audio via yt-dlp");
    const targetUrl = `https://www.bilibili.com/video/${bvid}?p=${pageNo}`;
    const args = [
      "--no-playlist",
      "-x",
      "--audio-format",
      "m4a",
      "--audio-quality",
      "10",
      "-o",
      audioTemplate,
    ];

    const ytDlpCookieFile = ensureYtDlpCookieFile({
      workDir,
      cookie,
      cookieFile,
    });
    if (ytDlpCookieFile) {
      args.push("--cookies", ytDlpCookieFile);
    }

    args.push(targetUrl);
    const downloadOptions = {
      venvPath,
      streamOutput: true,
      outputStream: progress?.rawOutputStream ?? progress?.outputStream,
      logger: progress?.logger ?? null,
      logContext: {
        scope: "subtitle",
        action: "download-audio",
        bvid,
        pageNo,
        cid,
        partTitle,
      },
    };

    try {
      await runVenvModuleImpl("yt_dlp", args, downloadOptions);
    } catch (error) {
      if (!isCachedMediaCodecProbeFailure(error)) {
        throw error;
      }

      const removedPaths = removeCachedAudioMediaFiles(workDir, stableBaseName);
      if (removedPaths.length === 0) {
        throw error;
      }

      progress?.logPartStage?.(
        pageNo,
        "Subtitle",
        `Removed ${removedPaths.length} invalid cached media file(s); retrying audio download`,
      );
      eventLogger?.log?.({
        scope: "subtitle",
        action: "recover-audio-cache",
        status: "succeeded",
        message: "Removed cached media after ffprobe could not identify its audio codec",
        details: {
          removedPaths,
        },
      });
      await runVenvModuleImpl("yt_dlp", args, downloadOptions);
    }
  }

  await transcribeWithRetriesImpl({
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

  return finalizeSubtitle({
    db,
    videoId,
    pageNo,
    cid,
    partTitle,
    eventLogger,
    subtitlePath,
    subtitleSource: "asr",
    subtitleLang: null,
    reused: false,
    durationSec,
  });
}

function isCachedMediaCodecProbeFailure(error: unknown) {
  const candidate = error as CommandError | null;
  const detail = [
    candidate?.message,
    candidate?.stdout,
    candidate?.stderr,
  ].map((value) => String(value ?? "")).join("\n").toLowerCase();
  return detail.includes("unable to obtain file audio codec with ffprobe");
}

function removeCachedAudioMediaFiles(workDir: string, stableBaseName: string) {
  const removableExtensions = new Set([
    ".aac",
    ".flv",
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".opus",
    ".part",
    ".ts",
    ".wav",
    ".webm",
    ".ytdl",
  ]);
  const filePrefix = `${stableBaseName}.`;
  const removedPaths: string[] = [];

  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(filePrefix)) {
      continue;
    }
    if (!removableExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const candidatePath = path.join(workDir, entry.name);
    fs.rmSync(candidatePath, { force: true });
    removedPaths.push(candidatePath);
  }

  return removedPaths;
}

function acceptSubtitleCandidate({
  subtitlePath,
  subtitleSource,
  pageNo,
  cid,
  partTitle,
  eventLogger,
  progress,
}: {
  subtitlePath: string;
  subtitleSource: string;
  pageNo: number;
  cid: number;
  partTitle: string;
  eventLogger: { log?: (event: Record<string, unknown>) => void } | null;
  progress: { logPartStage?: (pageNo: number, stage: string, message: string) => void } | null;
}) {
  const subtitleText = fs.readFileSync(subtitlePath, "utf8");
  const qualityCheck = inspectSubtitleQuality(subtitleText);

  if (qualityCheck.removedCueCount > 0 && qualityCheck.sanitizedSrt) {
    fs.writeFileSync(subtitlePath, qualityCheck.sanitizedSrt, "utf8");
    eventLogger?.log?.({
      scope: "subtitle",
      action: "sanitize",
      status: "succeeded",
      pageNo,
      cid,
      partTitle,
      message: `Removed ${qualityCheck.removedCueCount} likely volunteer-credit cue(s) from ${subtitleSource} subtitle`,
      details: {
        source: subtitleSource,
        removedCueCount: qualityCheck.removedCueCount,
        remainingCueCount: qualityCheck.remainingCueCount,
        volunteerCreditCueCount: qualityCheck.volunteerCreditCueCount,
        longestVolunteerCreditRun: qualityCheck.longestVolunteerCreditRun,
      },
    });
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Removed ${qualityCheck.removedCueCount} likely volunteer-credit subtitle cue(s) from ${subtitleSource}`,
    );
  }

  if (!qualityCheck.severeVolunteerCreditIssue) {
    return true;
  }

  const message = [
    "Detected repeated volunteer-credit placeholder subtitles",
    `(${qualityCheck.volunteerCreditCueCount}/${qualityCheck.totalCueCount}`,
    `cues, longest run ${qualityCheck.longestVolunteerCreditRun})`,
  ].join(" ");
  eventLogger?.log?.({
    scope: "subtitle",
    action: "quality-check",
    status: "failed",
    pageNo,
    cid,
    partTitle,
    message,
    details: {
      source: subtitleSource,
      volunteerCreditCueCount: qualityCheck.volunteerCreditCueCount,
      totalCueCount: qualityCheck.totalCueCount,
      remainingCueCount: qualityCheck.remainingCueCount,
      longestVolunteerCreditRun: qualityCheck.longestVolunteerCreditRun,
    },
  });
  progress?.logPartStage?.(
    pageNo,
    "Subtitle",
    `${message}, discarding ${subtitleSource} subtitle`,
  );
  return false;
}

function finalizeSubtitle({
  db,
  videoId,
  pageNo,
  cid,
  partTitle,
  eventLogger,
  subtitlePath,
  subtitleSource,
  subtitleLang,
  reused,
  durationSec,
}: SubtitleFinalizeInput) {
  const subtitleText = fs.readFileSync(subtitlePath, "utf8").trim();
  savePartSubtitle(db, videoId, pageNo, {
    subtitlePath,
    subtitleSource,
    subtitleLang,
    subtitleText,
  });
  eventLogger?.log({
    scope: "subtitle",
    action: "finalize",
    status: "succeeded",
    pageNo,
    cid,
    partTitle,
    message: `${reused ? "Reused local subtitle" : "Subtitle ready"} for P${pageNo}`,
    details: {
      source: subtitleSource,
      lang: subtitleLang,
      reused,
      subtitlePath,
    },
  });

  return {
    subtitlePath,
    subtitleSource,
    subtitleLang,
    reused,
    durationSec,
  };
}
