import fs from "node:fs";
import { runVenvModule } from "../shared/runtime-tools.js";
import {
  prependPathEntries,
  resolveLocalFasterWhisperConfig,
  resolveLocalFasterWhisperExecutableConfig,
} from "./faster-whisper-config.js";
import { notifyTranscriptionFailure } from "./notifier.js";
import { withTranscriptionQueueLock } from "./queue.js";
import { delay, formatErrorMessage, formatTranscriptionTarget } from "./utils.js";
const TRANSCRIPTION_RETRY_LIMIT = 3;
const TRANSCRIPTION_RETRY_DELAY_MS = 10_000;

interface LocalFasterWhisperConfig {
  exists: boolean;
  modelName: string;
  modelDir: string;
  modelPath: string;
}

export async function transcribeWithRetries({
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

function buildAsrFallbackPlan(asr: unknown): string[] {
  const preferred = String(asr ?? "").trim() || "faster-whisper";
  if (preferred === "faster-whisper") {
    return ["faster-whisper", "bijian", "jianying"];
  }

  if (preferred === "bijian") {
    return ["bijian", "jianying"];
  }

  return [preferred];
}

function buildTranscribeArgs({
  audioPath,
  subtitlePath,
  engine,
  localFasterWhisper,
}: {
  audioPath: string;
  subtitlePath: string;
  engine: string;
  localFasterWhisper: LocalFasterWhisperConfig | null;
}): string[] {
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

function buildTranscribeEnv({
  engine,
  localFasterWhisper,
  progress,
  pageNo,
}: {
  engine: string;
  localFasterWhisper: LocalFasterWhisperConfig | null;
  progress: { logPartStage?: (pageNo: number, stage: string, message: string) => void } | null | undefined;
  pageNo: number;
}): NodeJS.ProcessEnv | undefined {
  if (engine !== "faster-whisper" || !localFasterWhisper) {
    return undefined;
  }

  const env: NodeJS.ProcessEnv = {
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
