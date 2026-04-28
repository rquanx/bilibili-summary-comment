import fs from "node:fs";
import path from "node:path";
import { runCommand, runVenvModule } from "../shared/runtime-tools";
import {
  DEFAULT_FASTER_WHISPER_MODEL_NAME,
  prependPathEntries,
  resolveLocalFasterWhisperConfig,
  resolveLocalFasterWhisperExecutableConfig,
} from "./faster-whisper-config";
import { notifyTranscriptionFailure } from "./notifier";
import { inspectSubtitleQuality } from "./quality";
import { withTranscriptionQueueLock } from "./queue";
import { delay, formatErrorMessage, formatTranscriptionTarget } from "./utils";

const TRANSCRIPTION_RETRY_LIMIT = 3;
const TRANSCRIPTION_RETRY_DELAY_MS = 10_000;
const EXPECTED_TRANSCRIPTION_LANGUAGE = "zh";

interface LocalFasterWhisperConfig {
  exists: boolean;
  modelName: string;
  modelDir: string;
  modelPath: string;
}

interface LocalFasterWhisperExecutableConfig {
  device: string;
  programPath: string;
  pathEntries: string[];
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
  runTranscribeCommandImpl = runVenvModule,
  runDirectCommandImpl = runCommand,
  withTranscriptionQueueLockImpl = withTranscriptionQueueLock,
  notifyTranscriptionFailureImpl = notifyTranscriptionFailure,
  resolveLocalFasterWhisperConfigImpl = resolveLocalFasterWhisperConfig,
  resolveLocalFasterWhisperExecutableConfigImpl = resolveLocalFasterWhisperExecutableConfig,
}) {
  const engines = buildAsrFallbackPlan(asr);
  const failures = [];
  const localFasterWhisper = resolveLocalFasterWhisperConfigImpl();
  const localFasterWhisperExecutable = resolveLocalFasterWhisperExecutableConfigImpl();

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
        await withTranscriptionQueueLockImpl({
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

          if (shouldUseDirectFasterWhisper(engine, localFasterWhisperExecutable)) {
            const directArgs = buildDirectFasterWhisperArgs({
              audioPath,
              subtitlePath,
              localFasterWhisper,
              executableConfig: localFasterWhisperExecutable,
            });
            progress?.logPartStage?.(
              pageNo,
              "Subtitle",
              `Running direct FasterWhisper binary ${localFasterWhisperExecutable.programPath}`,
            );
            await runDirectCommandImpl(localFasterWhisperExecutable.programPath, directArgs, {
              env: buildDirectFasterWhisperEnv(localFasterWhisperExecutable),
              streamOutput: true,
              outputStream: progress?.rawOutputStream ?? progress?.outputStream,
              logger: progress?.logger ?? null,
              logContext: {
                scope: "subtitle",
                action: "asr-command",
                bvid,
                pageNo,
                cid,
                partTitle,
                engine,
                attempt,
              },
            });
            finalizeDirectFasterWhisperOutput({
              audioPath,
              subtitlePath,
            });
          } else {
            const transcribeArgs = buildTranscribeArgs({
              audioPath,
              subtitlePath,
              engine,
              localFasterWhisper,
            });
            const transcribeEnv = buildTranscribeEnv({
              engine,
              localFasterWhisper,
              executableConfig: localFasterWhisperExecutable,
              progress,
              pageNo,
            });
            await runTranscribeCommandImpl("videocaptioner", transcribeArgs, {
              venvPath,
              env: transcribeEnv,
              streamOutput: true,
              outputStream: progress?.rawOutputStream ?? progress?.outputStream,
              logger: progress?.logger ?? null,
              logContext: {
                scope: "subtitle",
                action: "asr-command",
                bvid,
                pageNo,
                cid,
                partTitle,
                engine,
                attempt,
              },
            });
          }
        });
        const subtitleText = fs.readFileSync(subtitlePath, "utf8");
        const qualityCheck = inspectSubtitleQuality(subtitleText);
        const severeVolunteerCreditIssue = qualityCheck.severeVolunteerCreditIssue;

        if (qualityCheck.removedCueCount > 0 && qualityCheck.sanitizedSrt) {
          fs.writeFileSync(subtitlePath, qualityCheck.sanitizedSrt, "utf8");
          eventLogger?.log({
            scope: "subtitle",
            action: "sanitize",
            status: "succeeded",
            pageNo,
            cid,
            partTitle,
            message: `Removed ${qualityCheck.removedCueCount} likely volunteer-credit cue(s) from ASR subtitle`,
            details: {
              engine,
              removedCueCount: qualityCheck.removedCueCount,
              remainingCueCount: qualityCheck.remainingCueCount,
              volunteerCreditCueCount: qualityCheck.volunteerCreditCueCount,
              longestVolunteerCreditRun: qualityCheck.longestVolunteerCreditRun,
            },
          });
          progress?.logPartStage?.(
            pageNo,
            "Subtitle",
            `Removed ${qualityCheck.removedCueCount} likely volunteer-credit subtitle cue(s)`,
          );
        }

        if (severeVolunteerCreditIssue) {
          fs.rmSync(subtitlePath, { force: true });
          const message = [
            `Detected repeated volunteer-credit placeholder subtitles`,
            `(${qualityCheck.volunteerCreditCueCount}/${qualityCheck.totalCueCount}`,
            `cues, longest run ${qualityCheck.longestVolunteerCreditRun})`,
          ].join(" ");
          failures.push(`${engine} quality check: ${message}`);
          eventLogger?.log({
            scope: "subtitle",
            action: "quality-check",
            status: "failed",
            pageNo,
            cid,
            partTitle,
            message,
            details: {
              engine,
              volunteerCreditCueCount: qualityCheck.volunteerCreditCueCount,
              totalCueCount: qualityCheck.totalCueCount,
              remainingCueCount: qualityCheck.remainingCueCount,
              longestVolunteerCreditRun: qualityCheck.longestVolunteerCreditRun,
            },
          });
          progress?.logPartStage?.(
            pageNo,
            "Subtitle",
            `${message}, switching ASR engine`,
          );

          if (engineIndex < engines.length - 1) {
            break;
          }

          continue;
        }

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

  await notifyTranscriptionFailureImpl({
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

export function buildTranscribeArgs({
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
    EXPECTED_TRANSCRIPTION_LANGUAGE,
    "--format",
    "srt",
    "-o",
    subtitlePath,
  ];

  if (engine === "faster-whisper") {
    args.push("--fw-model", localFasterWhisper?.modelName ?? DEFAULT_FASTER_WHISPER_MODEL_NAME);

    const configuredVadMethod = String(process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_METHOD ?? "").trim();
    if (configuredVadMethod) {
      args.push("--fw-vad-method", configuredVadMethod);
    }

    const configuredVadThreshold = String(process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_THRESHOLD ?? "").trim();
    if (configuredVadThreshold) {
      args.push("--fw-vad-threshold", configuredVadThreshold);
    }
  }

  return args;
}

export function buildDirectFasterWhisperArgs({
  audioPath,
  subtitlePath,
  localFasterWhisper,
  executableConfig,
}: {
  audioPath: string;
  subtitlePath: string;
  localFasterWhisper: LocalFasterWhisperConfig | null;
  executableConfig: LocalFasterWhisperExecutableConfig;
}): string[] {
  const args = [
    "-m",
    localFasterWhisper?.modelName ?? DEFAULT_FASTER_WHISPER_MODEL_NAME,
    "--print_progress",
  ];

  if (localFasterWhisper?.modelDir) {
    args.push("--model_dir", localFasterWhisper.modelDir);
  }

  args.push(
    audioPath,
    "-d",
    executableConfig.device,
    "--output_format",
    "srt",
    "-l",
    EXPECTED_TRANSCRIPTION_LANGUAGE,
    "-o",
    path.dirname(subtitlePath),
    "--vad_filter",
    "true",
    "--one_word",
    "0",
    "--sentence",
    "--max_line_width",
    "30",
    "--max_line_count",
    "1",
    "--max_comma",
    "20",
    "--max_comma_cent",
    "50",
    "--beep_off",
  );

  const configuredVadThreshold = String(process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_THRESHOLD ?? "").trim();
  args.push("--vad_threshold", configuredVadThreshold || "0.5");

  const configuredVadMethod = String(process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_METHOD ?? "").trim();
  if (configuredVadMethod) {
    args.push("--vad_method", configuredVadMethod.replaceAll("-", "_"));
  }

  if (executableConfig.device === "cuda") {
    args.push("--compute_type", "float16");
  }

  return args;
}

function buildTranscribeEnv({
  engine,
  localFasterWhisper,
  executableConfig,
  progress,
  pageNo,
}: {
  engine: string;
  localFasterWhisper: LocalFasterWhisperConfig | null;
  executableConfig: LocalFasterWhisperExecutableConfig | null;
  progress: { logPartStage?: (pageNo: number, stage: string, message: string) => void } | null | undefined;
  pageNo: number;
}): NodeJS.ProcessEnv | undefined {
  if (engine !== "faster-whisper" || !localFasterWhisper) {
    return undefined;
  }

  const env: NodeJS.ProcessEnv = {
    VIDEOCAPTIONER_FW_MODEL: localFasterWhisper.modelName,
  };

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

function buildDirectFasterWhisperEnv(
  executableConfig: LocalFasterWhisperExecutableConfig | null,
): NodeJS.ProcessEnv | undefined {
  if (!executableConfig) {
    return undefined;
  }

  return {
    ...process.env,
    PATH: prependPathEntries(process.env.PATH, executableConfig.pathEntries),
  };
}

function shouldUseDirectFasterWhisper(
  engine: string,
  executableConfig: LocalFasterWhisperExecutableConfig | null,
): executableConfig is LocalFasterWhisperExecutableConfig {
  return engine === "faster-whisper" && Boolean(executableConfig?.programPath);
}

function finalizeDirectFasterWhisperOutput({
  audioPath,
  subtitlePath,
}: {
  audioPath: string;
  subtitlePath: string;
}) {
  const generatedSubtitlePath = path.join(path.dirname(subtitlePath), `${path.parse(audioPath).name}.srt`);
  if (path.resolve(generatedSubtitlePath) === path.resolve(subtitlePath)) {
    return;
  }

  if (fs.existsSync(generatedSubtitlePath)) {
    fs.copyFileSync(generatedSubtitlePath, subtitlePath);
  }
}
