import { createHash } from "node:crypto";

// Optional shared shortener: retain the usable paste URL if it is unavailable.
export async function shortenSummaryUrl(target: string, fetchImpl = fetch): Promise<string> {
  const origin = String(process.env.KUTT_URL ?? "").trim();
  const apiKey = String(process.env.KUTT_API_KEY ?? "").trim();
  if (!origin && !apiKey) return target;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/"
      || base.search || base.hash || !apiKey) throw new Error("Invalid shortener configuration");
    const provider = String(process.env.SHORT_LINK_PROVIDER ?? "kutt").trim();
    if (provider !== "kutt" && provider !== "chhoto") throw new Error("Invalid shortener provider");
    // A fixed address plus reuse makes a later explicit retry recover an accepted POST.
    const address = createHash("sha256").update(target).digest("hex").slice(0, 10);
    if (provider === "chhoto") return await shortenWithChhoto(base, apiKey, target, address, fetchImpl);
    const response = await fetchImpl(new URL("/api/v2/links", base).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ target, customurl: address, reuse: true }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Shortener rejected the request");
    const data = await response.json() as { link?: string; target?: string };
    const short = new URL(data.link ?? "");
    if (data.target !== target || short.origin !== base.origin || short.username || short.password
      || short.search || short.hash || !/^\/[a-zA-Z0-9_-]{1,64}$/u.test(short.pathname)) {
      throw new Error("Invalid shortener response");
    }
    return short.href;
  } catch {
    // Never log request/response bodies: they contain the paste's decryption key.
    console.warn("Short-link creation failed; using the original PrivateBin link.");
    return target;
  }
}

async function shortenWithChhoto(base: URL, apiKey: string, target: string, address: string, fetchImpl: typeof fetch): Promise<string> {
  const signal = AbortSignal.timeout(15_000);
  const headers = { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": apiKey };
  const response = await fetchImpl(new URL("/api/new", base).href, {
    method: "POST", headers,
    body: JSON.stringify({ shortlink: address, longlink: target, expiry_delay: 0 }),
    redirect: "manual", signal,
  });
  if (!response.ok && response.status !== 400) throw new Error("Shortener rejected the request");
  const created = await response.json() as { success?: boolean; error?: boolean; shorturl?: string };
  // Chhoto 7.11.4 reports slug collisions as HTTP 400 with success=false. Never overwrite
  // an existing link: read it back and only reuse an identical, enabled mapping.
  if (!created || (created.success !== true && created.success !== false)
    || (created.success === true && (!response.ok || created.error !== false || created.shorturl !== new URL(address, base).href))
    || (created.success === false && created.error !== true)) throw new Error("Invalid shortener response");
  const check = await fetchImpl(new URL("/api/expand", base).href, {
    method: "QUERY", headers: { ...headers, "Content-Type": "text/plain" },
    body: address, redirect: "manual", signal,
  });
  if (!check.ok) throw new Error("Shortener verification failed");
  const stored = await check.json() as { success?: boolean; error?: boolean; longurl?: string; enabled?: boolean; expiry_time?: number };
  if (!stored || stored.success !== true || stored.error !== false || stored.longurl !== target
    || stored.enabled !== true || stored.expiry_time !== 0) throw new Error("Invalid shortener mapping");
  return new URL(address, base).href;
}
