import { formatBiliVideoUrlSuffix } from "../bili/video-url";

type ProgressOutputStream = Pick<NodeJS.WritableStream, "write">;

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
  const rawOutputStream = logger?.createStream({
    level: "debug",
    scope: "child-process",
    bvid: video?.bvid ?? null,
  }) ?? outputStream;

  function writeProgress(message, details = undefined) {
    const line = `[${formatProgressTime()}] ${videoPrefix} ${message}`;
    outputStream.write(`${line}\n`);
    logger?.progress(message, {
      bvid: video?.bvid ?? null,
      videoTitle: video?.title ?? null,
      ...details,
    });
  }

  return {
    outputStream,
    rawOutputStream,
    logger,
    log(message) {
      writeProgress(message);
    },
    logPart(index, part, stage, detail = "") {
      const partLabel = formatPartLabel(part.page_no, part.part_title);
      const suffix = detail ? `: ${detail}` : "";
      writeProgress(`[${index}/${safeTotalParts}] ${partLabel} ${stage}${suffix}`, {
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
      writeProgress(`[P${pageNo}] ${stage}${suffix}`, {
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

function formatProgressTime(date = new Date()) {
  return date.toTimeString().slice(0, 8);
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
