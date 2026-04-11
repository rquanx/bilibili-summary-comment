import { formatSummaryTime, parseSrt } from "../subtitle/srt-utils";
import { parseSummaryBlocks } from "./format";

const SUMMARY_TIMESTAMP_PATTERN = /^(?<timestamp>\d{2}:\d{2}(?::\d{2})?)\s+(?<content>.+)$/u;

export function normalizeSummaryOutput(
  text: string | null | undefined,
  pageNo: number,
  options: { subtitleText?: string | null } = {},
) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const blocks = parseSummaryBlocks(normalized);
  if (blocks.length === 0 || blocks.some((block) => block.page !== pageNo)) {
    return normalized;
  }

  const markerPattern = new RegExp(`^<${pageNo}P>\\s*`, "u");
  const bodyLines = [];

  for (const block of blocks) {
    const lines = block.lines.map((line, index) => (index === 0 ? line.replace(markerPattern, "") : line));

    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }

    bodyLines.push(...lines);
  }

  const compactBody = trimTrailingEmptyLines(bodyLines);
  if (compactBody.length === 0) {
    return `<${pageNo}P>`;
  }

  const nonEmptyBodyLines = compactBody.filter((line) => line.trim() !== "");
  if (nonEmptyBodyLines.length <= 1) {
    const singleLine = stripLeadingTimestamp(nonEmptyBodyLines[0] ?? "");
    return singleLine ? `<${pageNo}P> ${singleLine}`.trim() : `<${pageNo}P>`;
  }

  const alignedBody = alignSummaryTimestamps(compactBody, options.subtitleText);
  return [`<${pageNo}P>`, ...alignedBody].join("\n").trim();
}

function alignSummaryTimestamps(lines: string[], subtitleText: string | null | undefined) {
  const cueStarts = parseCueStarts(subtitleText);
  if (cueStarts.length === 0) {
    return lines;
  }

  const alignedLines = [];
  let minimumCueIndex = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      alignedLines.push(line);
      continue;
    }

    const match = trimmedLine.match(SUMMARY_TIMESTAMP_PATTERN);
    if (!match) {
      alignedLines.push(line);
      continue;
    }

    const summarySec = parseSummaryTimestamp(match.groups?.timestamp ?? "");
    if (!Number.isFinite(summarySec)) {
      alignedLines.push(line);
      continue;
    }

    const alignedCueIndex = findNearestCueIndex(cueStarts, summarySec, minimumCueIndex);
    if (alignedCueIndex === null) {
      alignedLines.push(line);
      continue;
    }

    minimumCueIndex = alignedCueIndex;
    alignedLines.push(`${formatSummaryTime(cueStarts[alignedCueIndex])} ${match.groups?.content?.trim() ?? ""}`.trim());
  }

  return alignedLines;
}

function parseCueStarts(subtitleText: string | null | undefined) {
  const cues = parseSrt(subtitleText);
  if (cues.length === 0) {
    return [];
  }

  return cues.map((cue) => cue.startSec);
}

function findNearestCueIndex(cueStarts: number[], summarySec: number, minimumCueIndex: number) {
  if (minimumCueIndex >= cueStarts.length) {
    return null;
  }

  let bestIndex = minimumCueIndex;
  let bestDelta = Math.abs(cueStarts[minimumCueIndex] - summarySec);

  for (let index = minimumCueIndex + 1; index < cueStarts.length; index += 1) {
    const delta = Math.abs(cueStarts[index] - summarySec);
    if (delta > bestDelta && cueStarts[index] > summarySec) {
      break;
    }

    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function stripLeadingTimestamp(line: string | null | undefined) {
  const trimmedLine = String(line ?? "").trim();
  if (!trimmedLine) {
    return "";
  }

  const match = trimmedLine.match(SUMMARY_TIMESTAMP_PATTERN);
  return match ? (match.groups?.content ?? "").trim() : trimmedLine;
}

function parseSummaryTimestamp(value: string | null | undefined) {
  const parts = String(value ?? "").split(":").map((part) => Number(part));
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return Number.NaN;
}

function trimTrailingEmptyLines(lines: string[]) {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }
  return result;
}
