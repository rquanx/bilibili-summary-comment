export function buildBiliVideoUrl({
  bvid = null,
  aid = null,
  pageNo = null,
}: {
  bvid?: unknown;
  aid?: unknown;
  pageNo?: unknown;
} = {}): string | null {
  const normalizedBvid = normalizeBvid(bvid);
  const normalizedAid = normalizeAid(aid);
  const normalizedPageNo = normalizePageNo(pageNo);

  const baseUrl = normalizedBvid
    ? `https://www.bilibili.com/video/${normalizedBvid}`
    : normalizedAid
      ? `https://www.bilibili.com/video/av${normalizedAid}`
      : null;
  if (!baseUrl) {
    return null;
  }

  return normalizedPageNo ? `${baseUrl}?p=${normalizedPageNo}` : baseUrl;
}

export function formatBiliVideoUrlSuffix(context: { bvid?: unknown; aid?: unknown; pageNo?: unknown } = {}): string {
  const videoUrl = buildBiliVideoUrl(context);
  return videoUrl ? ` | ${videoUrl}` : "";
}

export function attachVideoContextToError(
  error: unknown,
  { bvid = null, aid = null, pageNo = null }: { bvid?: unknown; aid?: unknown; pageNo?: unknown } = {},
) {
  if (!error || typeof error !== "object") {
    return error;
  }

  const candidate = error as Record<string, unknown>;
  const normalizedBvid = normalizeBvid(candidate.bvid ?? bvid);
  const normalizedAid = normalizeAid(candidate.aid ?? aid);
  const normalizedPageNo = normalizePageNo(candidate.pageNo ?? pageNo);
  const videoUrl = buildBiliVideoUrl({
    bvid: normalizedBvid,
    aid: normalizedAid,
    pageNo: normalizedPageNo,
  });

  if (normalizedBvid && !normalizeBvid(candidate.bvid)) {
    candidate.bvid = normalizedBvid;
  }

  if (normalizedAid && !normalizeAid(candidate.aid)) {
    candidate.aid = normalizedAid;
  }

  if (normalizedPageNo && !normalizePageNo(candidate.pageNo)) {
    candidate.pageNo = normalizedPageNo;
  }

  if (videoUrl && !String(candidate.videoUrl ?? "").trim()) {
    candidate.videoUrl = videoUrl;
  }

  return error;
}

function normalizeBvid(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeAid(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizePageNo(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}
