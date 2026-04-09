interface ErrorLike {
  message?: unknown;
}

interface QueueOwnerLike {
  bvid?: unknown;
  videoTitle?: unknown;
  pageNo?: unknown;
  partTitle?: unknown;
}

export function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function formatErrorMessage(error: unknown): string {
  const errorLike = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
  const message = String(errorLike.message ?? "Unknown error").trim();
  return message || "Unknown error";
}

export function formatTranscriptionTarget({
  bvid,
  videoTitle,
  pageNo,
  partTitle,
}: QueueOwnerLike): string {
  const pieces = [
    String(bvid ?? "").trim(),
    String(videoTitle ?? "").trim(),
    `P${pageNo}`,
    String(partTitle ?? "").trim(),
  ].filter(Boolean);
  return pieces.join(" | ");
}

export function formatQueueOwnerLabel(owner: QueueOwnerLike | null | undefined): string {
  if (!owner) {
    return "";
  }

  return formatTranscriptionTarget({
    bvid: owner.bvid,
    videoTitle: owner.videoTitle,
    pageNo: owner.pageNo,
    partTitle: owner.partTitle,
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
