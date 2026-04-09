import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, runVenvModule } from "./runtime-tools.mjs";
import { savePartSubtitle } from "./storage.mjs";
import { tryDownloadBiliSubtitle } from "./subtitle-bili.mjs";
import { ensureYtDlpCookieFile } from "./subtitle-cookie-file.mjs";
import { transcribeWithRetries } from "./subtitle-transcriber.mjs";
import { formatErrorMessage } from "./subtitle-utils.mjs";

export async function ensureSubtitleForPart({
  client,
  db,
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
  asr = "faster-whisper",
  progress = null,
  eventLogger = null,
}) {
  const workDir = path.join(getRepoRoot(), workRoot, bvid);
  fs.mkdirSync(workDir, { recursive: true });

  const stableBaseName = `cid-${String(cid)}`;
  const subtitlePath = path.join(workDir, `${stableBaseName}.srt`);
  const audioTemplate = path.join(workDir, `${stableBaseName}.%(ext)s`);
  const audioPath = path.join(workDir, `${stableBaseName}.m4a`);

  if (existingSubtitlePath && fs.existsSync(existingSubtitlePath)) {
    return finalizeSubtitle({
      db,
      videoId,
      pageNo,
      cid,
      partTitle,
      eventLogger,
      subtitlePath: existingSubtitlePath,
      subtitleSource: "local",
      subtitleLang: null,
      reused: true,
    });
  }

  if (fs.existsSync(subtitlePath)) {
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

  progress?.logPartStage?.(pageNo, "Subtitle", "Trying Bilibili subtitle");
  let biliSubtitle = null;
  try {
    biliSubtitle = await tryDownloadBiliSubtitle({
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
    await runVenvModule("yt_dlp", args, {
      venvPath,
      streamOutput: true,
      outputStream: progress?.outputStream,
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
}) {
  savePartSubtitle(db, videoId, pageNo, {
    subtitlePath,
    subtitleSource,
    subtitleLang,
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
