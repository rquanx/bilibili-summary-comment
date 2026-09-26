export interface SummaryUserTarget {
  mid: number;
  source: string;
  includeOnlySelfVisible?: boolean;
}

export function parseSummaryUsers(
  summaryUsers: unknown,
  includeOnlySelfVisibleUsers: unknown = "",
): SummaryUserTarget[] {
  const raw = String(summaryUsers ?? "");
  if (!raw.trim()) {
    return [];
  }

  const onlySelfVisibleMids = parseBiliUserIds(includeOnlySelfVisibleUsers);
  const targets: SummaryUserTarget[] = [];
  const seen = new Set<number>();

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
      includeOnlySelfVisible: onlySelfVisibleMids.has(mid),
    });
  }

  return targets;
}

function parseBiliUserIds(value: unknown): Set<number> {
  const mids = new Set<number>();
  for (const entry of String(value ?? "").split(/[,\r\n]+/)) {
    const mid = extractBiliMid(entry);
    if (mid) {
      mids.add(mid);
    }
  }
  return mids;
}

export function normalizePipelineUserKey(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || "__default__";
}

export function extractBiliMid(input: unknown): number | null {
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
