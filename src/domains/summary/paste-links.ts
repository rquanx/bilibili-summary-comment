// Historical paste.rs and MicroBin links remain readable after changing providers.
export function isSummaryPasteUrl(value: string): boolean {
  if (/^https:\/\/paste\.rs\/[^\s?#]+$/u.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const shortener = String(process.env.KUTT_URL ?? "").trim();
    if (shortener && url.origin === new URL(shortener).origin && !url.search && !url.hash
      && /^\/[a-zA-Z0-9_-]{1,64}$/u.test(url.pathname)) return true;
    const privatebin = [String(process.env.PRIVATEBIN_URL ?? ""), ...String(process.env.PRIVATEBIN_LEGACY_URLS ?? "").split(",")];
    const matchesPasteOrigin = privatebin.some(value => {
      try {
        const configured = new URL(value.trim());
        return configured.protocol === "https:" && !configured.username && !configured.password && url.origin === configured.origin;
      } catch { return false; }
    });
    if (matchesPasteOrigin && url.pathname === "/"
      && /^\?[a-f0-9]{16}$/u.test(url.search) && /^#-?[1-9A-HJ-NP-Za-km-z]{32,45}(?:&view=(?:reader|original))?$/u.test(url.hash)) return true;
    const microbin = String(process.env.MICROBIN_URL ?? "").trim();
    return !!microbin && url.origin === new URL(microbin).origin && !url.search && !url.hash
      && /^\/raw\/[a-zA-Z0-9_-]+$/u.test(url.pathname);
  } catch {
    return false;
  }
}

export function containsSummaryPasteLink(text: string): boolean {
  return (String(text ?? "").match(/https:\/\/[^\s<>]+/gu) ?? []).some(isSummaryPasteUrl);
}
