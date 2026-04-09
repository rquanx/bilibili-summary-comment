import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, runVenvModule } from "./runtime-tools.mjs";
import { savePartSubtitle } from "./storage.mjs";

const DEFAULT_FASTER_WHISPER_MODEL_PATH = "C:\\Users\\91658\\AppData\\Local\\VideoCaptioner\\AppData\\models\\faster-whisper-large-v3-turbo";
const DEFAULT_FASTER_WHISPER_MODEL_NAME = "large-v3-turbo";
const DEFAULT_FASTER_WHISPER_BIN_CANDIDATES = [
  "C:\\Users\\91658\\AppData\\Local\\VideoCaptioner\\resource\\bin\\Faster-Whisper-XXL",
  "C:\\Users\\91658\\AppData\\Local\\VideoCaptioner\\resource\\bin",
];
const TRANSCRIPTION_QUEUE_LOCK_NAME = "videocaptioner-asr.lock";
const TRANSCRIPTION_QUEUE_HEARTBEAT_MS = 60_000;
const TRANSCRIPTION_QUEUE_WAIT_MS = 5_000;
const TRANSCRIPTION_QUEUE_STALE_MS = 2 * 60 * 60 * 1000;
const TRANSCRIPTION_RETRY_LIMIT = 3;
const TRANSCRIPTION_RETRY_DELAY_MS = 10_000;
const TRANSCRIPTION_FAILURE_TITLE = "\u8f6c\u5f55\u5931\u8d25";

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
    savePartSubtitle(db, videoId, pageNo, {
      subtitlePath: existingSubtitlePath,
      subtitleSource: "local",
      subtitleLang: null,
    });
    eventLogger?.log({
      scope: "subtitle",
      action: "finalize",
      status: "succeeded",
      pageNo,
      cid,
      partTitle,
      message: `Reused local subtitle for P${pageNo}`,
      details: {
        source: "local",
        reused: true,
        subtitlePath: existingSubtitlePath,
      },
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
    eventLogger?.log({
      scope: "subtitle",
      action: "finalize",
      status: "succeeded",
      pageNo,
      cid,
      partTitle,
      message: `Reused local subtitle for P${pageNo}`,
      details: {
        source: "local",
        reused: true,
        subtitlePath,
      },
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
    eventLogger?.log({
      scope: "subtitle",
      action: "finalize",
      status: "succeeded",
      pageNo,
      cid,
      partTitle,
      message: `Downloaded Bilibili subtitle for P${pageNo}`,
      details: {
        source: biliSubtitle.source,
        lang: biliSubtitle.lang,
        subtitlePath,
      },
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

  savePartSubtitle(db, videoId, pageNo, {
    subtitlePath,
    subtitleSource: "asr",
    subtitleLang: null,
  });
  eventLogger?.log({
    scope: "subtitle",
    action: "finalize",
    status: "succeeded",
    pageNo,
    cid,
    partTitle,
    message: `ASR subtitle ready for P${pageNo}`,
    details: {
      source: "asr",
      subtitlePath,
    },
  });

  return {
    subtitlePath,
    subtitleSource: "asr",
    subtitleLang: null,
    reused: false,
    durationSec,
  };
}

async function transcribeWithRetries({
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
}) {
  const engines = buildAsrFallbackPlan(asr);
  const failures = [];
  const localFasterWhisper = resolveLocalFasterWhisperConfig();

  for (const [engineIndex, engine] of engines.entries()) {
    if (engineIndex > 0) {
      eventLogger?.log({
        scope: "subtitle",
        action: "fallback",
        status: "started",
        pageNo,
        cid,
        partTitle,
        message: `Switching ASR engine to ${engine}`,
        details: {
          engine,
        },
      });
      progress?.logPartStage?.(pageNo, "Subtitle", `Switching ASR to ${engine}`);
    }

    for (let attempt = 1; attempt <= TRANSCRIPTION_RETRY_LIMIT; attempt += 1) {
      try {
        fs.rmSync(subtitlePath, { force: true });
        await withTranscriptionQueueLock({
          workRoot,
          progress,
          bvid,
          videoTitle,
          pageNo,
          partTitle,
          engine,
          eventLogger,
          cid,
        }, async () => {
          const transcribeArgs = buildTranscribeArgs({
            audioPath,
            subtitlePath,
            engine,
            localFasterWhisper,
          });
          const transcribeEnv = buildTranscribeEnv({
            engine,
            localFasterWhisper,
            progress,
            pageNo,
          });
          const transcriptionLabel = formatTranscriptionTarget({
            bvid,
            videoTitle,
            pageNo,
            partTitle,
          });

          eventLogger?.log({
            scope: "subtitle",
            action: "asr",
            status: "started",
            pageNo,
            cid,
            partTitle,
            message: `Starting ASR ${engine} for ${transcriptionLabel}`,
            details: {
              engine,
              attempt,
              attemptLimit: TRANSCRIPTION_RETRY_LIMIT,
              subtitlePath,
            },
          });
          progress?.logPartStage?.(
            pageNo,
            "Subtitle",
            `Running transcription with ASR ${engine} (${attempt}/${TRANSCRIPTION_RETRY_LIMIT}): ${transcriptionLabel}`,
          );
          await runVenvModule("videocaptioner", transcribeArgs, {
            venvPath,
            env: transcribeEnv,
            streamOutput: true,
            outputStream: progress?.outputStream,
          });
        });
        eventLogger?.log({
          scope: "subtitle",
          action: "asr",
          status: "succeeded",
          pageNo,
          cid,
          partTitle,
          message: `ASR ${engine} completed for P${pageNo}`,
          details: {
            engine,
            attempt,
            attemptLimit: TRANSCRIPTION_RETRY_LIMIT,
          },
        });
        return;
      } catch (error) {
        const message = formatErrorMessage(error);
        failures.push(`${engine} attempt ${attempt}: ${message}`);
        eventLogger?.log({
          scope: "subtitle",
          action: "asr",
          status: "failed",
          pageNo,
          cid,
          partTitle,
          message,
          details: {
            engine,
            attempt,
            attemptLimit: TRANSCRIPTION_RETRY_LIMIT,
          },
        });
        progress?.logPartStage?.(
          pageNo,
          "Subtitle",
          `ASR ${engine} failed (${attempt}/${TRANSCRIPTION_RETRY_LIMIT}): ${message}`,
        );

        if (attempt < TRANSCRIPTION_RETRY_LIMIT) {
          eventLogger?.log({
            scope: "subtitle",
            action: "retry",
            status: "started",
            pageNo,
            cid,
            partTitle,
            message: `Retrying ASR ${engine} after failure`,
            details: {
              engine,
              nextAttempt: attempt + 1,
            },
          });
          progress?.logPartStage?.(
            pageNo,
            "Subtitle",
            `Waiting ${Math.floor(TRANSCRIPTION_RETRY_DELAY_MS / 1000)}s before retrying ${engine}`,
          );
          await delay(TRANSCRIPTION_RETRY_DELAY_MS);
          continue;
        }

        if (engineIndex < engines.length - 1) {
          progress?.logPartStage?.(
            pageNo,
            "Subtitle",
            `${engine} exhausted after ${TRANSCRIPTION_RETRY_LIMIT} attempts, preparing fallback`,
          );
        }
      }
    }
  }

  await notifyTranscriptionFailure({
    progress,
    pageNo,
    bvid,
    cid,
  });
  eventLogger?.log({
    scope: "subtitle",
    action: "finalize",
    status: "failed",
    pageNo,
    cid,
    partTitle,
    message: `Transcription failed for ${bvid} P${pageNo}`,
    details: {
      failures,
    },
  });

  throw new Error(
    `Transcription failed for ${bvid} P${pageNo} (cid ${cid}) after ${TRANSCRIPTION_RETRY_LIMIT} attempts per ASR: ${failures.join(" | ")}`,
  );
}

function buildAsrFallbackPlan(asr) {
  const preferred = String(asr ?? "").trim() || "faster-whisper";
  if (preferred === "faster-whisper") {
    return ["faster-whisper", "bijian", "jianying"];
  }

  if (preferred === "bijian") {
    return ["bijian", "jianying"];
  }

  return [preferred];
}

function buildTranscribeArgs({ audioPath, subtitlePath, engine, localFasterWhisper }) {
  const args = [
    "transcribe",
    audioPath,
    "--asr",
    engine,
    "--language",
    "auto",
    "--format",
    "srt",
    "-o",
    subtitlePath,
  ];

  if (engine === "faster-whisper" && localFasterWhisper?.modelName) {
    args.push("--fw-model", localFasterWhisper.modelName);
  }

  return args;
}

function buildTranscribeEnv({ engine, localFasterWhisper, progress, pageNo }) {
  if (engine !== "faster-whisper" || !localFasterWhisper) {
    return undefined;
  }

  const env = {
    VIDEOCAPTIONER_FW_MODEL: localFasterWhisper.modelName,
  };
  const executableConfig = resolveLocalFasterWhisperExecutableConfig();

  if (localFasterWhisper.exists) {
    env.VIDEOCAPTIONER_FW_MODEL_DIR = localFasterWhisper.modelDir;
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Preferring local FasterWhisper model ${localFasterWhisper.modelName} (${localFasterWhisper.modelPath})`,
    );
  } else {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Local FasterWhisper model path not found, using default model discovery (${localFasterWhisper.modelPath})`,
    );
  }

  if (executableConfig) {
    env.PATH = prependPathEntries(process.env.PATH, executableConfig.pathEntries);
    env.VIDEOCAPTIONER_FW_DEVICE = executableConfig.device;
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Using local FasterWhisper executable ${executableConfig.programPath} (${executableConfig.device})`,
    );
  } else {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      "Local FasterWhisper executable not found in known directories; falling back to PATH lookup",
    );
  }

  return env;
}

function resolveLocalFasterWhisperConfig() {
  const configuredPath = firstNonEmptyString(
    process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH,
    DEFAULT_FASTER_WHISPER_MODEL_PATH,
  );
  if (!configuredPath) {
    return null;
  }

  const resolvedPath = path.resolve(configuredPath);
  const baseName = path.basename(resolvedPath);
  const inferredModelName = inferFasterWhisperModelName(baseName);
  const isModelDirectory = /^faster-whisper-/i.test(baseName) || inferredModelName === baseName.toLowerCase();

  return {
    modelPath: resolvedPath,
    modelDir: isModelDirectory ? path.dirname(resolvedPath) : resolvedPath,
    modelName: inferredModelName,
    exists: fs.existsSync(resolvedPath),
  };
}

function inferFasterWhisperModelName(value) {
  const normalizedValue = String(value ?? "").trim().toLowerCase();
  const supportedModels = new Set([
    "tiny",
    "base",
    "small",
    "medium",
    "large-v1",
    "large-v2",
    "large-v3",
    "large-v3-turbo",
  ]);

  if (supportedModels.has(normalizedValue)) {
    return normalizedValue;
  }

  const prefixedMatch = /^faster-whisper-(.+)$/.exec(normalizedValue);
  if (prefixedMatch && supportedModels.has(prefixedMatch[1])) {
    return prefixedMatch[1];
  }

  return DEFAULT_FASTER_WHISPER_MODEL_NAME;
}

function resolveLocalFasterWhisperExecutableConfig() {
  const candidates = [];
  const configuredDir = firstNonEmptyString(process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN);
  if (configuredDir) {
    candidates.push(path.resolve(configuredDir));
  }

  const localAppData = firstNonEmptyString(process.env.LOCALAPPDATA);
  if (localAppData) {
    candidates.push(
      path.join(localAppData, "VideoCaptioner", "resource", "bin", "Faster-Whisper-XXL"),
      path.join(localAppData, "VideoCaptioner", "resource", "bin"),
    );
  }

  candidates.push(...DEFAULT_FASTER_WHISPER_BIN_CANDIDATES.map((item) => path.resolve(item)));

  const uniqueCandidates = [...new Set(candidates)];
  for (const directory of uniqueCandidates) {
    const programPath = findFasterWhisperProgramInDir(directory);
    if (!programPath) {
      continue;
    }

    const pathEntries = [path.dirname(programPath)];
    if (path.dirname(programPath) !== directory) {
      pathEntries.push(directory);
    }

    return {
      device: inferFasterWhisperDevice(programPath),
      programPath,
      pathEntries,
    };
  }

  return null;
}

function findFasterWhisperProgramInDir(directory) {
  if (!directory || !fs.existsSync(directory)) {
    return null;
  }

  const programCandidates = [
    path.join(directory, "faster-whisper-xxl.exe"),
    path.join(directory, "faster-whisper.exe"),
    path.join(directory, "faster_whisper.exe"),
  ];

  for (const programPath of programCandidates) {
    if (fs.existsSync(programPath)) {
      return programPath;
    }
  }

  return null;
}

function prependPathEntries(existingPath, entries) {
  const cleanedEntries = Array.isArray(entries)
    ? entries.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const existingEntries = String(existingPath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry.trim());

  return [...new Set([...cleanedEntries, ...existingEntries])].join(path.delimiter);
}

function inferFasterWhisperDevice(programPath) {
  const normalizedPath = String(programPath ?? "").toLowerCase();
  return normalizedPath.includes("faster-whisper-xxl") ? "cuda" : "cpu";
}

async function withTranscriptionQueueLock({ workRoot, progress, bvid, videoTitle, pageNo, partTitle, engine, eventLogger, cid }, task) {
  const release = await acquireTranscriptionQueueLock({
    workRoot,
    progress,
    bvid,
    videoTitle,
    pageNo,
    partTitle,
    engine,
    eventLogger,
    cid,
  });

  try {
    return await task();
  } finally {
    release();
  }
}

async function acquireTranscriptionQueueLock({ workRoot, progress, bvid, videoTitle, pageNo, partTitle, engine, eventLogger, cid }) {
  const lockRoot = path.join(getRepoRoot(), workRoot, ".locks");
  const lockPath = path.join(lockRoot, TRANSCRIPTION_QUEUE_LOCK_NAME);
  fs.mkdirSync(lockRoot, { recursive: true });

  let waitLogged = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      const ownerPath = path.join(lockPath, "owner.json");
      const writeHeartbeat = () => {
        fs.writeFileSync(ownerPath, `${JSON.stringify({
          pid: process.pid,
          engine,
          bvid,
          videoTitle,
          pageNo,
          partTitle,
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
      };

      writeHeartbeat();
      const heartbeat = setInterval(() => {
        try {
          writeHeartbeat();
        } catch {
          // Ignore heartbeat failures; stale cleanup will handle abandoned locks.
        }
      }, TRANSCRIPTION_QUEUE_HEARTBEAT_MS);

      return () => {
        clearInterval(heartbeat);
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (isStaleTranscriptionQueueLock(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (!waitLogged) {
        const owner = readTranscriptionQueueOwner(lockPath);
        const ownerLabel = formatQueueOwnerLabel(owner);
        eventLogger?.log({
          scope: "subtitle",
          action: "queue",
          status: "waiting",
          pageNo,
          cid,
          partTitle,
          message: ownerLabel
            ? `ASR ${engine} is waiting for the transcription queue; current owner ${ownerLabel}`
            : `ASR ${engine} is waiting for the transcription queue`,
          details: {
            engine,
            owner,
          },
        });
        progress?.logPartStage?.(
          pageNo,
          "Subtitle",
          ownerLabel
            ? `ASR ${engine} is waiting for the transcription queue, current owner ${ownerLabel}`
            : `ASR ${engine} is waiting for the transcription queue`,
        );
        waitLogged = true;
      }

      await delay(TRANSCRIPTION_QUEUE_WAIT_MS);
    }
  }
}

function isStaleTranscriptionQueueLock(lockPath) {
  const owner = readTranscriptionQueueOwner(lockPath);
  if (owner?.pid && !isProcessAlive(owner.pid)) {
    return true;
  }

  const ownerPath = path.join(lockPath, "owner.json");
  const statTarget = fs.existsSync(ownerPath) ? ownerPath : lockPath;

  try {
    const stats = fs.statSync(statTarget);
    return Date.now() - stats.mtimeMs > TRANSCRIPTION_QUEUE_STALE_MS;
  } catch {
    return false;
  }
}

function readTranscriptionQueueOwner(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
  if (!fs.existsSync(ownerPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(ownerPath, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return {
      ...parsed,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }

    return false;
  }
}

async function notifyTranscriptionFailure({ progress, pageNo, bvid, cid }) {
  const sendKey = String(process.env.SERVER_CHAN_SEND_KEY ?? "").trim();
  if (!sendKey) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      "SERVER_CHAN_SEND_KEY is not configured, skipping transcription failure notification",
    );
    return;
  }

  const notificationUrl = `https://sctapi.ftqq.com/${sendKey}.send?title=${encodeURIComponent(TRANSCRIPTION_FAILURE_TITLE)}`;

  try {
    const response = await fetch(notificationUrl);
    if (!response.ok) {
      throw new Error(`ServerChan responded with ${response.status} ${response.statusText}`);
    }
    progress?.logPartStage?.(pageNo, "Subtitle", `Sent transcription failure notification for ${bvid} P${pageNo} (cid ${cid})`);
  } catch (error) {
    progress?.logPartStage?.(
      pageNo,
      "Subtitle",
      `Failed to send transcription failure notification (${formatErrorMessage(error)})`,
    );
  }
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

function formatTranscriptionTarget({ bvid, videoTitle, pageNo, partTitle }) {
  const pieces = [
    String(bvid ?? "").trim(),
    String(videoTitle ?? "").trim(),
    `P${pageNo}`,
    String(partTitle ?? "").trim(),
  ].filter(Boolean);
  return pieces.join(" | ");
}

function formatQueueOwnerLabel(owner) {
  if (!owner) {
    return "";
  }

  return formatTranscriptionTarget({
    bvid: owner.bvid,
    videoTitle: owner.videoTitle,
    pageNo: owner.pageNo,
    partTitle: owner.partTitle,
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}
