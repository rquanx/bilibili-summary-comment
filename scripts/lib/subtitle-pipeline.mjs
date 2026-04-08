import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, runCommand, runVenvModule } from "./runtime-tools.mjs";
import { savePartSubtitle } from "./storage.mjs";

export async function ensureSubtitleForPart({
  client,
  db,
  videoId,
  bvid,
  pageNo,
  cid,
  existingSubtitlePath = null,
  cookie,
  cookieFile = null,
  durationSec = 0,
  workRoot = "work",
  venvPath = ".3.11",
  asr = "bijian",
  progress = null,
}) {
  const workDir = path.join(getRepoRoot(), workRoot, bvid);
  fs.mkdirSync(workDir, { recursive: true });

  const stableBaseName = `cid-${String(cid)}`;
  const subtitlePath = path.join(workDir, `${stableBaseName}.srt`);
  const audioTemplate = path.join(workDir, `${stableBaseName}.%(ext)s`);
  const audioPath = path.join(workDir, `${stableBaseName}.m4a`);

  if (existingSubtitlePath && fs.existsSync(existingSubtitlePath)) {
    savePartSubtitle(db, videoId, pageNo, {
      subtitlePath: existingSubtitlePath,
      subtitleSource: "local",
      subtitleLang: null,
    });
    return {
      subtitlePath: existingSubtitlePath,
      subtitleSource: "local",
      subtitleLang: null,
      reused: true,
    };
  }

  if (fs.existsSync(subtitlePath)) {
    savePartSubtitle(db, videoId, pageNo, {
      subtitlePath,
      subtitleSource: "local",
      subtitleLang: null,
    });
    return {
      subtitlePath,
      subtitleSource: "local",
      subtitleLang: null,
      reused: true,
    };
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
    savePartSubtitle(db, videoId, pageNo, {
      subtitlePath,
      subtitleSource: biliSubtitle.source,
      subtitleLang: biliSubtitle.lang,
    });
    return {
      subtitlePath,
      subtitleSource: biliSubtitle.source,
      subtitleLang: biliSubtitle.lang,
      reused: false,
    };
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

  progress?.logPartStage?.(pageNo, "Subtitle", `Running transcription with ASR ${asr}`);
  await runVenvModule("videocaptioner", [
    "transcribe",
    audioPath,
    "--asr",
    asr,
    "--language",
    "auto",
    "--format",
    "srt",
    "-o",
    subtitlePath,
  ], {
    venvPath,
    streamOutput: true,
    outputStream: progress?.outputStream,
  });

  savePartSubtitle(db, videoId, pageNo, {
    subtitlePath,
    subtitleSource: "asr",
    subtitleLang: null,
  });

  return {
    subtitlePath,
    subtitleSource: "asr",
    subtitleLang: null,
    reused: false,
    durationSec,
  };
}

function ensureYtDlpCookieFile({ workDir, cookie, cookieFile }) {
  const resolvedCookieFile = resolveCookieFile(cookieFile);
  if (resolvedCookieFile) {
    const rawCookieFile = fs.readFileSync(resolvedCookieFile, "utf8").replace(/^\uFEFF/, "").trim();
    if (isNetscapeCookieJar(rawCookieFile)) {
      return resolvedCookieFile;
    }
  }

  const cookieHeader = firstNonEmptyString(
    cookie,
    resolvedCookieFile ? fs.readFileSync(resolvedCookieFile, "utf8") : null,
  );
  if (!cookieHeader) {
    return null;
  }

  const cookieJarPath = path.join(workDir, "yt-dlp-cookies.txt");
  fs.writeFileSync(cookieJarPath, convertCookieHeaderToNetscape(cookieHeader), "utf8");
  return cookieJarPath;
}

async function tryDownloadBiliSubtitle({ client, bvid, cid, subtitlePath, cookie }) {
  const playerInfo = await client.video.playerInfo({ bvid, cid });
  const subtitles = playerInfo?.subtitle?.subtitles ?? [];
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    return null;
  }

  const picked = subtitles.find((item) => Number(item.ai_type ?? 0) > 0 || Number(item.ai_status ?? 0) > 0) ?? subtitles[0];
  const subtitleUrl = normalizeSubtitleUrl(picked.subtitle_url_v2 ?? picked.subtitle_url);
  if (!subtitleUrl) {
    return null;
  }

  const response = await fetch(subtitleUrl, {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: `https://www.bilibili.com/video/${bvid}`,
      ...(cookie ? { cookie } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Bilibili subtitle: ${response.status} ${response.statusText}`);
  }

  const subtitleJson = await response.json();
  const srtText = convertBiliSubtitleJsonToSrt(subtitleJson);
  if (!srtText.trim()) {
    return null;
  }

  fs.writeFileSync(subtitlePath, `${srtText.trim()}\n`, "utf8");
  return {
    source: Number(picked.ai_type ?? 0) > 0 || Number(picked.ai_status ?? 0) > 0 ? "bili_ai" : "bili_subtitle",
    lang: picked.lan ?? null,
  };
}

function normalizeSubtitleUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    return null;
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  return `https://${url.replace(/^\/+/, "")}`;
}

function convertBiliSubtitleJsonToSrt(data) {
  const body = Array.isArray(data?.body) ? data.body : [];
  const lines = [];
  let index = 1;

  for (const item of body) {
    const from = Number(item?.from);
    const to = Number(item?.to);
    const content = String(item?.content ?? "").trim();

    if (!Number.isFinite(from) || !Number.isFinite(to) || !content) {
      continue;
    }

    lines.push(String(index));
    lines.push(`${formatSrtTimestamp(from)} --> ${formatSrtTimestamp(to)}`);
    lines.push(content);
    lines.push("");
    index += 1;
  }

  return lines.join("\n");
}

function resolveCookieFile(cookieFile) {
  if (typeof cookieFile !== "string" || !cookieFile.trim()) {
    return null;
  }

  const resolvedPath = path.resolve(cookieFile);
  return fs.existsSync(resolvedPath) ? resolvedPath : null;
}

function isNetscapeCookieJar(content) {
  const trimmed = String(content ?? "").trim();
  return trimmed.startsWith("# Netscape HTTP Cookie File");
}

function convertCookieHeaderToNetscape(cookieHeader) {
  const lines = ["# Netscape HTTP Cookie File", "# This file is generated from the project's cookie header."];

  for (const part of String(cookieHeader ?? "").split(";")) {
    const trimmedPart = part.trim();
    if (!trimmedPart) {
      continue;
    }

    const separatorIndex = trimmedPart.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmedPart.slice(0, separatorIndex).trim();
    const value = trimmedPart.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    lines.push([".bilibili.com", "TRUE", "/", "FALSE", "2147483647", name, value].join("\t"));
  }

  return `${lines.join("\n")}\n`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function formatErrorMessage(error) {
  const message = String(error?.message ?? "Unknown error").trim();
  return message || "Unknown error";
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}
