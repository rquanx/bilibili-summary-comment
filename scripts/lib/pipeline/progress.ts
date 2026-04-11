import { formatBiliVideoUrlSuffix } from "../bili/video-url";

export function createProgressReporter(video, totalParts) {
  const outputStream = process.stderr;
  const safeTotalParts = Math.max(totalParts, 1);
  const videoPrefix = formatVideoPrefix(video);

  return {
    outputStream,
    log(message) {
      outputStream.write(`[${formatProgressTime()}] ${videoPrefix} ${message}\n`);
    },
    logPart(index, part, stage, detail = "") {
      const partLabel = formatPartLabel(part.page_no, part.part_title);
      const suffix = detail ? `: ${detail}` : "";
      outputStream.write(
        `[${formatProgressTime()}] ${videoPrefix} [${index}/${safeTotalParts}] ${partLabel} ${stage}${suffix}\n`,
      );
    },
    logPartStage(pageNo, stage, detail = "") {
      const suffix = detail ? `: ${detail}` : "";
      outputStream.write(`[${formatProgressTime()}] ${videoPrefix} [P${pageNo}] ${stage}${suffix}\n`);
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
  const bvid = String(video?.bvid ?? "").trim();
  const title = String(video?.title ?? "").trim();
  const videoUrl = formatBiliVideoUrlSuffix({
    bvid,
    aid: video?.aid,
  }).replace(/^ \| /u, "");
  const labelWithUrl = [bvid, title, videoUrl].filter(Boolean).join(" | ");
  return labelWithUrl ? `[${labelWithUrl}]` : "[video]";
}
