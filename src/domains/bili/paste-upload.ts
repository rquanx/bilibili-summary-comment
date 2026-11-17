import { createCipheriv, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { createCliError } from "../../shared/cli/errors";
import { shortenSummaryUrl } from "./short-link";

const deriveKey = promisify(pbkdf2);
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeKey(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let result = "";
  while (value > 0n) {
    result = base58Alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

export function getPasteUploadEndpoint() {
  const value = String(process.env.PRIVATEBIN_URL ?? "").trim();
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw createCliError("PRIVATEBIN_URL must be configured before uploading summaries");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw createCliError("PRIVATEBIN_URL must be an HTTPS origin without credentials or a path");
  }
  return base.toString();
}

export async function uploadTextToPaste(text: string, fetchImpl = fetch): Promise<string> {
  const endpoint = getPasteUploadEndpoint();
  const secret = randomBytes(32);
  const iv = randomBytes(16);
  const salt = randomBytes(8);
  // PrivateBin v2: authenticate the complete encryption specification and display options.
  const adata = [[iv.toString("base64"), salt.toString("base64"), 100000, 256, 128, "aes", "gcm", "none"], "plaintext", 0, 0];
  const key = await deriveKey(secret, salt, 100000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(adata), "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ paste: String(text ?? "") }), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "JSONHttpRequest" },
    body: JSON.stringify({ v: 2, adata, ct: encrypted.toString("base64"), meta: { expire: "never" } }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  // A timeout may follow a successful creation; don't blindly repeat non-idempotent POSTs.
  const body = await response.text();
  let data: { status?: number; id?: string; message?: string } = {};
  try { data = JSON.parse(body); } catch { /* Report bounded response below. */ }
  if (!response.ok || data?.status !== 0 || typeof data.id !== "string" || !/^[a-f0-9]{16}$/u.test(data.id)) {
    throw createCliError("Failed to upload problematic comment content to PrivateBin", {
      status: response.status, endpoint, responseBody: body.slice(0, 2000),
    });
  }
  // Only the fragment carries the key: it is never transmitted to the paste server.
  return shortenSummaryUrl(`${endpoint}?${data.id}#${encodeKey(secret)}&view=reader`, fetchImpl);
}
