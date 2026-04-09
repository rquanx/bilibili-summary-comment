export function parseSummaryUsers(summaryUsers) {
  const raw = String(summaryUsers ?? "");
  if (!raw.trim()) {
    return [];
  }

  const targets = [];
  const seen = new Set();

  for (const entry of raw.split(/[,\r\n]+/)) {
    const input = entry.trim();
    if (!input) {
      continue;
    }

    const mid = extractBiliMid(input);
    if (!mid || seen.has(mid)) {
      continue;
    }

    seen.add(mid);
    targets.push({
      mid,
      source: input,
    });
  }

  return targets;
}

export function normalizePipelineUserKey(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "__default__";
}

export function extractBiliMid(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const directMatch = trimmed.match(/^\d+$/);
  if (directMatch) {
    return Number(directMatch[0]);
  }

  const urlMatch = trimmed.match(/space\.bilibili\.com\/(\d+)/i) ?? trimmed.match(/\/(\d+)(?:[/?#]|$)/);
  if (!urlMatch) {
    return null;
  }

  return Number(urlMatch[1]);
}
