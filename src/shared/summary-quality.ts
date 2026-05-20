const SUMMARY_MARKER_INLINE_PATTERN = /^(<\d+P>)(?:\s+(.*))?$/u;
const SUMMARY_MARKER_ONLY_PATTERN = /^<\d+P>$/u;
const SUMMARY_TIMESTAMP_PREFIX_PATTERN = /^(?:\d+#)?\d{2}:\d{2}(?::\d{2})?\s+/u;
const SUMMARY_EXACT_PROMOTIONAL_PATTERN = /\u8bf7\u4e0d\u541d\u70b9\u8d5e\u8ba2\u9605\u8ba2\u9605\u8f6c\u53d1\u6253\u8d4f\u652f\u6301\u660e\u955c\u4e0e\u70b9\u70b9\u680f\u76ee/u;
const SUMMARY_SHORT_DURATION_PATTERN = /(?:^|[\s，,])(?:该|本)?分?P?(?:时长)?仅\d+秒(?:钟)?/u;
const SUMMARY_NO_SUBTITLE_PATTERN = /无(?:可用)?字幕(?:记录|内容)?|无字幕(?:记录|内容)?|未见字幕|没有字幕/u;
const SUMMARY_NO_CONTENT_PATTERN = /无法提取有效内容(?:或看点)?|无有效内容(?:或看点)?|无可概括内容/u;
const SUMMARY_TRANSITION_PATTERN = /转场|片头|片尾|过渡片段|空白片段/u;
const CTA_KEYWORD_PATTERNS = [
  /\u70b9\u8d5e/u,
  /\u8ba2\u9605/u,
  /\u8f6c\u53d1/u,
  /\u6253\u8d4f/u,
  /\u652f\u6301/u,
];
const CHANNEL_NAME_PATTERN = /\u660e\u955c\u4e0e\u70b9\u70b9\u680f\u76ee/u;
const OUTRO_PATTERN = /\u7247\u5c3e\u7ed3\u675f\u8bed/u;

export function sanitizeSummaryText(text: string | null | undefined) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const sanitizedLines: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) {
      sanitizedLines.push("");
      continue;
    }

    const markerMatch = trimmedLine.match(SUMMARY_MARKER_INLINE_PATTERN);
    if (markerMatch) {
      const marker = markerMatch[1];
      const inlineContent = String(markerMatch[2] ?? "").trim();
      if (!inlineContent) {
        sanitizedLines.push(marker);
        continue;
      }

      if (!isSkippableSummaryContent(stripSummaryTimingPrefix(inlineContent))) {
        sanitizedLines.push(`${marker} ${inlineContent}`.trim());
      } else {
        sanitizedLines.push(marker);
      }
      continue;
    }

    if (isSkippableSummaryContent(stripSummaryTimingPrefix(trimmedLine))) {
      continue;
    }

    sanitizedLines.push(rawLine);
  }

  const compactedLines = trimEmptyBoundaryLines(collapseRepeatedBlankLines(sanitizedLines));
  return compactedLines.join("\n").trim();
}

export function isSummaryMarkerOnly(text: string | null | undefined) {
  return SUMMARY_MARKER_ONLY_PATTERN.test(String(text ?? "").trim());
}

export function isLikelyPromotionalSummaryContent(text: string | null | undefined) {
  const normalized = normalizeSummaryCueText(text);
  if (!normalized) {
    return false;
  }

  if (SUMMARY_EXACT_PROMOTIONAL_PATTERN.test(normalized)) {
    return true;
  }

  const ctaKeywordCount = CTA_KEYWORD_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(normalized) ? 1 : 0),
    0,
  );

  if (!CHANNEL_NAME_PATTERN.test(normalized)) {
    return false;
  }

  return ctaKeywordCount >= 3 || (OUTRO_PATTERN.test(normalized) && ctaKeywordCount >= 2);
}

export function isLikelyNonContentSummaryContent(text: string | null | undefined) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return false;
  }

  const hasShortDuration = SUMMARY_SHORT_DURATION_PATTERN.test(normalized);
  const hasNoSubtitle = SUMMARY_NO_SUBTITLE_PATTERN.test(normalized);
  const hasNoContent = SUMMARY_NO_CONTENT_PATTERN.test(normalized);
  const hasTransitionCue = SUMMARY_TRANSITION_PATTERN.test(normalized);

  return (hasShortDuration && (hasNoSubtitle || hasNoContent))
    || (hasNoSubtitle && hasTransitionCue)
    || (hasNoContent && hasTransitionCue);
}

function stripSummaryTimingPrefix(text: string) {
  return String(text ?? "").trim().replace(SUMMARY_TIMESTAMP_PREFIX_PATTERN, "");
}

function isSkippableSummaryContent(text: string) {
  return isLikelyPromotionalSummaryContent(text) || isLikelyNonContentSummaryContent(text);
}

function normalizeSummaryCueText(text: string | null | undefined) {
  return String(text ?? "")
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function collapseRepeatedBlankLines(lines: string[]) {
  const result: string[] = [];

  for (const line of lines) {
    if (line.trim() !== "") {
      result.push(line);
      continue;
    }

    if (result.length === 0 || result[result.length - 1].trim() === "") {
      continue;
    }

    result.push("");
  }

  return result;
}

function trimEmptyBoundaryLines(lines: string[]) {
  const result = [...lines];

  while (result.length > 0 && result[0].trim() === "") {
    result.shift();
  }

  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }

  return result;
}
