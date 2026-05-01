import { formatBiliVideoUrlSuffix } from "../bili/video-url";
import { formatEast8Time } from "../../shared/time";

type ProgressOutputStream = Pick<NodeJS.WritableStream, "write"> & {
  isTTY?: boolean;
};

export type ProgressLevel = "debug" | "info" | "progress" | "success" | "warn" | "error";

interface ProgressLogDetails extends Record<string, unknown> {
  level?: ProgressLevel;
}

export function createProgressReporter(
  video,
  totalParts,
  {
    logger = null,
    outputStream = process.stderr,
  }: {
    logger?: { createStream?: (details?: Record<string, unknown>) => ProgressOutputStream; progress?: (message: string, details?: Record<string, unknown>) => void } | null;
    outputStream?: ProgressOutputStream;
  } = {},
) {
  const safeTotalParts = Math.max(totalParts, 1);
  const videoPrefix = formatVideoPrefix(video);
  const colorEnabled = shouldUseTerminalColors(outputStream);
  const rawOutputStream = logger?.createStream({
    level: "debug",
    scope: "child-process",
    bvid: video?.bvid ?? null,
  }) ?? outputStream;

  function writeProgress(level: ProgressLevel, message: string, details: ProgressLogDetails = {}) {
    const line = formatTerminalMessage({
      level,
      message,
      prefix: videoPrefix,
      colorEnabled,
    });
    outputStream.write(`${line}\n`);
    logger?.progress(message, {
      bvid: video?.bvid ?? null,
      videoTitle: video?.title ?? null,
      level,
      ...details,
    });
  }

  return {
    outputStream,
    rawOutputStream,
    logger,
    log(message, details: ProgressLogDetails = {}) {
      writeProgress(details.level ?? "progress", message, details);
    },
    info(message, details: ProgressLogDetails = {}) {
      writeProgress("info", message, details);
    },
    success(message, details: ProgressLogDetails = {}) {
      writeProgress("success", message, details);
    },
    warn(message, details: ProgressLogDetails = {}) {
      writeProgress("warn", message, details);
    },
    error(message, details: ProgressLogDetails = {}) {
      writeProgress("error", message, details);
    },
    logPart(index, part, stage, detail = "") {
      const partLabel = formatPartLabel(part.page_no, part.part_title);
      const suffix = detail ? `: ${detail}` : "";
      writeProgress(resolveStageLevel(stage), `[${index}/${safeTotalParts}] ${partLabel} ${stage}${suffix}`, {
        pageNo: part?.page_no ?? null,
        cid: part?.cid ?? null,
        partTitle: part?.part_title ?? null,
        index,
        totalParts: safeTotalParts,
        stage,
        detail: detail || null,
      });
    },
    logPartStage(pageNo, stage, detail = "") {
      const suffix = detail ? `: ${detail}` : "";
      writeProgress(resolveStageLevel(stage), `[P${pageNo}] ${stage}${suffix}`, {
        pageNo,
        stage,
        detail: detail || null,
      });
    },
  };
}

export function trimCommandOutput(output, maxLength = 4000) {
  if (typeof output !== "string") {
    return undefined;
  }

  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

export function formatBlockingErrorDetail(error, maxLength = 300) {
  const message = extractErrorMessage(error);
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "Unknown error";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

export function writeTerminalMessage(
  outputStream: ProgressOutputStream,
  level: ProgressLevel,
  message: string,
  {
    prefix = "",
  }: {
    prefix?: string;
  } = {},
) {
  outputStream.write(
    `${formatTerminalMessage({
      level,
      message,
      prefix,
      colorEnabled: shouldUseTerminalColors(outputStream),
    })}\n`,
  );
}

function formatProgressTime(date = new Date()) {
  return formatEast8Time(date);
}

function formatTerminalMessage({
  level,
  message,
  prefix = "",
  colorEnabled,
}: {
  level: ProgressLevel;
  message: string;
  prefix?: string;
  colorEnabled: boolean;
}) {
  const time = `[${formatProgressTime()}]`;
  const levelLabel = colorize(`[${level.toUpperCase()}]`, getLevelColor(level), colorEnabled);
  const prefixText = prefix ? `${prefix} ` : "";
  return `${time} ${levelLabel} ${prefixText}${message}`;
}

function resolveStageLevel(stage: unknown): ProgressLevel {
  const normalized = String(stage ?? "").trim().toLowerCase();
  if (!normalized) {
    return "progress";
  }

  if (normalized.includes("failed") || normalized.includes("blocked") || normalized.includes("error")) {
    return "error";
  }

  if (normalized.includes("ready") || normalized.includes("complete") || normalized.includes("completed")) {
    return "success";
  }

  if (normalized.includes("warn") || normalized.includes("skip")) {
    return "warn";
  }

  if (normalized.includes("start") || normalized.includes("generating")) {
    return "info";
  }

  return "progress";
}

function shouldUseTerminalColors(outputStream: ProgressOutputStream): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (process.env.FORCE_COLOR === "0") {
    return false;
  }

  if (process.env.FORCE_COLOR) {
    return true;
  }

  return Boolean(outputStream.isTTY);
}

function colorize(text: string, colorCode: number, enabled: boolean): string {
  if (!enabled) {
    return text;
  }

  return `\u001b[${colorCode}m${text}\u001b[0m`;
}

function getLevelColor(level: ProgressLevel): number {
  switch (level) {
    case "debug":
      return 90;
    case "info":
      return 36;
    case "success":
      return 32;
    case "warn":
      return 33;
    case "error":
      return 31;
    case "progress":
    default:
      return 94;
  }
}

function extractErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String(error.message ?? "");
  }

  return String(error ?? "");
}

function formatPartLabel(pageNo, partTitle) {
  const normalizedTitle = String(partTitle ?? "").trim();
  return normalizedTitle ? `P${pageNo} ${normalizedTitle}` : `P${pageNo}`;
}

function formatVideoPrefix(video) {
  const title = String(video?.title ?? "").trim();
  const videoUrl = formatBiliVideoUrlSuffix({
    bvid: video?.bvid,
    aid: video?.aid,
  }).replace(/^ \| /u, "");
  const labelWithUrl = [title, videoUrl].filter(Boolean).join(" | ");
  return labelWithUrl ? `[${labelWithUrl}]` : "[video]";
}
