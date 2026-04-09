export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function formatErrorMessage(error) {
  const message = String(error?.message ?? "Unknown error").trim();
  return message || "Unknown error";
}

export function formatTranscriptionTarget({ bvid, videoTitle, pageNo, partTitle }) {
  const pieces = [
    String(bvid ?? "").trim(),
    String(videoTitle ?? "").trim(),
    `P${pageNo}`,
    String(partTitle ?? "").trim(),
  ].filter(Boolean);
  return pieces.join(" | ");
}

export function formatQueueOwnerLabel(owner) {
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

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
