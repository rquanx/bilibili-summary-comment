import { listVideoParts, listVideos, savePartSummary } from "./storage.mjs";

const TITLE_VARIANT_SUFFIX_PATTERN =
  /\s*[\[(（【]?\s*(?:纯净版|弹幕版|无弹幕版|无弹幕|录播版|熟肉版)\s*[\])）】]?\s*$/u;

export function normalizeLiveSessionTitle(title) {
  let normalized = normalizeText(title);
  let previous = "";

  while (normalized && normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(TITLE_VARIANT_SUFFIX_PATTERN, "").trim();
  }

  return normalized;
}

export function buildLiveSessionKey({ title, parts }) {
  const normalizedTitle = normalizeLiveSessionTitle(title);
  const normalizedParts = normalizeParts(parts);
  if (!normalizedTitle || normalizedParts.length === 0) {
    return null;
  }

  return `${normalizedTitle}\n${normalizedParts.map((part) => `${part.pageNo}:${part.partTitle}`).join("\n")}`;
}

export function findReusableSummarySource(db, currentVideo, currentParts) {
  const currentKey = buildLiveSessionKey({
    title: currentVideo?.title,
    parts: currentParts,
  });
  if (!currentKey) {
    return null;
  }

  const candidates = listVideos(db);
  for (const candidateVideo of candidates) {
    if (candidateVideo.id === currentVideo.id) {
      continue;
    }

    if (Number(candidateVideo.page_count ?? 0) !== currentParts.length) {
      continue;
    }

    const candidateParts = listVideoParts(db, candidateVideo.id);
    if (!hasReusableSummaries(candidateParts)) {
      continue;
    }

    const candidateKey = buildLiveSessionKey({
      title: candidateVideo.title,
      parts: candidateParts,
    });
    if (candidateKey !== currentKey) {
      continue;
    }

    return {
      video: candidateVideo,
      parts: candidateParts,
      liveSessionKey: currentKey,
    };
  }

  return null;
}

export function reusePartSummaries(db, targetVideoId, sourceParts) {
  const targetParts = new Map(listVideoParts(db, targetVideoId).map((part) => [part.page_no, part]));
  const reusedPages = [];

  for (const part of sourceParts) {
    const targetPart = targetParts.get(part.page_no);
    if (String(targetPart?.summary_text ?? "").trim()) {
      continue;
    }

    const summaryText = String(part.summary_text ?? "").trim();
    const summaryHash = String(part.summary_hash ?? "").trim();
    if (!summaryText || !summaryHash) {
      continue;
    }

    savePartSummary(db, targetVideoId, part.page_no, {
      summaryText,
      summaryHash,
    });
    reusedPages.push(part.page_no);
  }

  return reusedPages;
}

function hasReusableSummaries(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return false;
  }

  return parts.every((part) => String(part.summary_text ?? "").trim() && String(part.summary_hash ?? "").trim());
}

function normalizeParts(parts) {
  return [...(Array.isArray(parts) ? parts : [])]
    .map((part) => ({
      pageNo: Number(part?.page_no ?? part?.pageNo ?? 0),
      partTitle: normalizeText(part?.part_title ?? part?.partTitle ?? ""),
    }))
    .filter((part) => part.pageNo > 0 && part.partTitle)
    .sort((left, right) => left.pageNo - right.pageNo);
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
