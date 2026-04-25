export function normalizeStoredSummaryText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function getPreferredSummaryText(part: {
  summary_text?: string | null;
  summary_text_processed?: string | null;
} | null | undefined): string {
  return normalizeStoredSummaryText(part?.summary_text_processed)
    ?? normalizeStoredSummaryText(part?.summary_text)
    ?? "";
}

export function hasPreferredSummaryText(part: {
  summary_text?: string | null;
  summary_text_processed?: string | null;
} | null | undefined): boolean {
  return Boolean(getPreferredSummaryText(part));
}

export function hasRawSummaryText(part: { summary_text?: string | null } | null | undefined): boolean {
  return Boolean(normalizeStoredSummaryText(part?.summary_text));
}
