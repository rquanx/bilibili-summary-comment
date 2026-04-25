import {
  hasRawSummaryText,
  listVideoParts,
  listVideos,
  normalizeStoredSummaryText,
  savePartSummary,
} from "../db/index";

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

  return `${normalizedTitle}\n${normalizedParts.map((part) => part.partTitle).join("\n")}`;
}

export function findReusableSummarySource(db, currentVideo, currentParts) {
  const liveSessionTitle = normalizeLiveSessionTitle(currentVideo?.title);
  if (!liveSessionTitle) {
    return null;
  }

  const candidates = listVideos(db);
  let bestCandidate = null;
  for (const candidateVideo of candidates) {
    if (candidateVideo.id === currentVideo.id) {
      continue;
    }

    if (normalizeLiveSessionTitle(candidateVideo.title) !== liveSessionTitle) {
      continue;
    }

    const candidateParts = listVideoParts(db, candidateVideo.id);
    const reusableMatches = findMatchingParts(currentParts, candidateParts, {
      canReuseTargetPart(part) {
        return !hasRawSummaryText(part);
      },
      canReuseSourcePart(part) {
        return Boolean(hasRawSummaryText(part) && String(part.summary_hash ?? "").trim());
      },
    });
    if (reusableMatches.length === 0) {
      continue;
    }

    if (isBetterCandidate(bestCandidate, candidateVideo, reusableMatches)) {
      bestCandidate = {
        video: candidateVideo,
        parts: candidateParts,
        matchedPages: reusableMatches.map((match) => match.targetPageNo),
      };
    }
  }

  if (!bestCandidate) {
    return null;
  }

  return {
    video: bestCandidate.video,
    parts: bestCandidate.parts,
    liveSessionKey: liveSessionTitle,
    matchedPages: bestCandidate.matchedPages,
  };
}

export function reusePartSummaries(db, targetVideoId, sourceParts) {
  const targetParts = listVideoParts(db, targetVideoId);
  const sourceActiveParts = Array.isArray(sourceParts) ? sourceParts : [];
  const reusedPages = [];

  const reusableMatches = findMatchingParts(targetParts, sourceActiveParts, {
      canReuseTargetPart(part) {
        return !hasRawSummaryText(part);
      },
      canReuseSourcePart(part) {
        return Boolean(hasRawSummaryText(part) && String(part.summary_hash ?? "").trim());
      },
  });

  for (const match of reusableMatches) {
    const summaryText = normalizeStoredSummaryText(match.sourcePart.summary_text) ?? "";
    const summaryHash = String(match.sourcePart.summary_hash ?? "").trim();
    savePartSummary(db, targetVideoId, match.targetPageNo, {
      summaryText,
      processedSummaryText: normalizeStoredSummaryText(match.sourcePart.summary_text_processed),
      summaryHash,
    });
    reusedPages.push(match.targetPageNo);
  }

  return reusedPages;
}

export function findReusableSubtitleSource(db, currentVideo, targetPart) {
  const liveSessionTitle = normalizeLiveSessionTitle(currentVideo?.title);
  const normalizedPartTitle = normalizeText(targetPart?.part_title ?? targetPart?.partTitle ?? "");
  if (!liveSessionTitle || !normalizedPartTitle) {
    return null;
  }

  const candidates = listVideos(db);
  let bestMatch = null;
  for (const candidateVideo of candidates) {
    if (candidateVideo.id === currentVideo.id) {
      continue;
    }

    if (normalizeLiveSessionTitle(candidateVideo.title) !== liveSessionTitle) {
      continue;
    }

    const candidateParts = listVideoParts(db, candidateVideo.id);
    const reusableMatches = findMatchingParts([targetPart], candidateParts, {
      canReuseSourcePart(part) {
        return Boolean(String(part.subtitle_path ?? "").trim());
      },
    });
    if (reusableMatches.length === 0) {
      continue;
    }

    const candidateMatch = reusableMatches[0];
    if (isBetterSubtitleMatch(bestMatch, candidateVideo, candidateMatch, targetPart)) {
      bestMatch = {
        video: candidateVideo,
        part: candidateMatch.sourcePart,
      };
    }
  }

  return bestMatch;
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

function findMatchingParts(
  targetParts,
  sourceParts,
  options: {
    canReuseTargetPart?: (part: Record<string, unknown>) => boolean;
    canReuseSourcePart?: (part: Record<string, unknown>) => boolean;
  } = {},
) {
  const normalizedTargetParts = normalizeSourceParts(targetParts);
  const normalizedSourceParts = normalizeSourceParts(sourceParts);
  const sourceBuckets = new Map();
  const matches = [];

  for (const sourcePart of normalizedSourceParts) {
    if (options.canReuseSourcePart && !options.canReuseSourcePart(sourcePart.rawPart)) {
      continue;
    }

    const bucket = sourceBuckets.get(sourcePart.partTitle) ?? [];
    bucket.push(sourcePart);
    sourceBuckets.set(sourcePart.partTitle, bucket);
  }

  for (const targetPart of normalizedTargetParts) {
    if (options.canReuseTargetPart && !options.canReuseTargetPart(targetPart.rawPart)) {
      continue;
    }

    const bucket = sourceBuckets.get(targetPart.partTitle);
    if (!bucket || bucket.length === 0) {
      continue;
    }

    const sourcePart = bucket.shift();
    matches.push({
      targetPageNo: targetPart.pageNo,
      targetPart: targetPart.rawPart,
      sourcePart: sourcePart.rawPart,
    });
  }

  return matches;
}

function normalizeSourceParts(parts) {
  return [...(Array.isArray(parts) ? parts : [])]
    .map((part) => ({
      rawPart: part,
      pageNo: Number(part?.page_no ?? part?.pageNo ?? 0),
      partTitle: normalizeText(part?.part_title ?? part?.partTitle ?? ""),
    }))
    .filter((part) => part.pageNo > 0 && part.partTitle)
    .sort((left, right) => left.pageNo - right.pageNo);
}

function isBetterCandidate(currentCandidate, nextVideo, nextMatches) {
  if (!currentCandidate) {
    return true;
  }

  if (nextMatches.length !== currentCandidate.matchedPages.length) {
    return nextMatches.length > currentCandidate.matchedPages.length;
  }

  return String(nextVideo.updated_at ?? "") > String(currentCandidate.video.updated_at ?? "");
}

function isBetterSubtitleMatch(currentMatch, nextVideo, nextMatch, targetPart) {
  if (!currentMatch) {
    return true;
  }

  const nextSamePage = Number(nextMatch.sourcePart?.page_no ?? 0) === Number(targetPart?.page_no ?? targetPart?.pageNo ?? 0);
  const currentSamePage = Number(currentMatch.part?.page_no ?? 0) === Number(targetPart?.page_no ?? targetPart?.pageNo ?? 0);
  if (nextSamePage !== currentSamePage) {
    return nextSamePage;
  }

  return String(nextVideo.updated_at ?? "") > String(currentMatch.video.updated_at ?? "");
}
