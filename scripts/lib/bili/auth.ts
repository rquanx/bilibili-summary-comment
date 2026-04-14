import fs from "node:fs";
import path from "node:path";
import { TvQrcodeLogin } from "@renmu/bili-api";
import { getRepoRoot } from "../shared/runtime-tools";

const DEFAULT_AUTH_DIR = ".auth";
export const DEFAULT_AUTH_FILE = path.posix.join(DEFAULT_AUTH_DIR, "bili-auth.json");
const DEFAULT_COOKIE_FILE = "cookie.txt";

export function resolveBiliAuthFile(filePath = null) {
  return path.resolve(getRepoRoot(), filePath ?? process.env.BILI_AUTH_FILE ?? DEFAULT_AUTH_FILE);
}

export function resolveBiliCookieFile(filePath = null) {
  return path.resolve(getRepoRoot(), filePath ?? process.env.BILI_COOKIE_FILE ?? DEFAULT_COOKIE_FILE);
}

export function resolveBiliLoginOutputFiles({
  authFile = null,
  cookieFile = null,
  repoRoot = getRepoRoot(),
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
}: {
  authFile?: string | null;
  cookieFile?: string | null;
  repoRoot?: string;
  existsSync?: (targetPath: fs.PathLike) => boolean;
  readdirSync?: typeof fs.readdirSync;
} = {}) {
  const explicitAuthFile = typeof authFile === "string" && authFile.trim() ? authFile.trim() : null;
  const explicitCookieFile = typeof cookieFile === "string" && cookieFile.trim() ? cookieFile.trim() : null;
  const resolvedAuthFile = path.resolve(repoRoot, explicitAuthFile ?? process.env.BILI_AUTH_FILE ?? DEFAULT_AUTH_FILE);
  const resolvedCookieFile = explicitCookieFile
    ? path.resolve(repoRoot, explicitCookieFile)
    : null;

  if (explicitAuthFile && explicitCookieFile) {
    return {
      authFile: resolvedAuthFile,
      cookieFile: resolvedCookieFile,
      slot: normalizeIndexedFileSlot(resolvedAuthFile),
    };
  }

  const slot = explicitAuthFile
    ? normalizeIndexedFileSlot(resolvedAuthFile)
    : findNextAvailableIndexedFileSlot(resolvedAuthFile, {
        existsSync,
        readdirSync,
      });

  return {
    authFile: explicitAuthFile ? resolvedAuthFile : buildIndexedSiblingPath(resolvedAuthFile, slot),
    cookieFile: resolvedCookieFile,
    slot,
  };
}

export function loadBiliAuthBundle(authFile = resolveBiliAuthFile()) {
  if (!fs.existsSync(authFile)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(authFile, "utf8"));
}

export function getLastAuthUpdateAt(bundle) {
  if (!bundle || typeof bundle !== "object") {
    return null;
  }

  const value = bundle.updatedAt ?? bundle.updated_at ?? bundle.raw?.updatedAt ?? null;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return null;
}

export function extractBiliAuthState(bundle) {
  const tokenInfo = bundle?.tokenInfo ?? bundle?.token_info ?? bundle?.raw?.tokenInfo ?? bundle?.raw?.token_info ?? null;
  const cookieInfo = bundle?.cookieInfo ?? bundle?.cookie_info ?? bundle?.raw?.cookieInfo ?? bundle?.raw?.cookie_info ?? null;
  const accessToken = firstNonEmptyString(
    bundle?.accessToken,
    bundle?.access_key,
    tokenInfo?.accessToken,
    tokenInfo?.access_token,
    bundle?.raw?.accessToken,
    bundle?.raw?.access_key,
  );
  const refreshToken = firstNonEmptyString(
    bundle?.refreshToken,
    bundle?.refresh_token,
    tokenInfo?.refreshToken,
    tokenInfo?.refresh_token,
    bundle?.raw?.refreshToken,
    bundle?.raw?.refresh_token,
  );
  const mid = firstDefinedNumber(bundle?.mid, tokenInfo?.mid, bundle?.raw?.mid);
  const expiresIn = firstDefinedNumber(bundle?.expiresIn, tokenInfo?.expiresIn, tokenInfo?.expires_in, bundle?.raw?.expiresIn);

  return {
    accessToken,
    refreshToken,
    mid,
    expiresIn,
    cookieInfo,
  };
}

export function buildCookieStringFromBundle(bundle) {
  const { cookieInfo } = extractBiliAuthState(bundle);
  const cookies = normalizeCookieEntries(cookieInfo);
  return cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}

export function readCookieStringFromAuthFile(authFile = resolveBiliAuthFile()) {
  const bundle = loadBiliAuthBundle(authFile);
  if (!bundle) {
    throw new Error(`Bilibili auth file not found: ${authFile}`);
  }

  const cookieString = buildCookieStringFromBundle(bundle).trim();
  if (!cookieString) {
    throw new Error(`Bilibili auth file does not contain a usable cookie: ${authFile}`);
  }

  return cookieString;
}

export function normalizeBiliAuthBundle(rawData, source = "unknown") {
  const authState = extractBiliAuthState(rawData);
  const cookies = normalizeCookieEntries(authState.cookieInfo);

  if (!authState.accessToken || !authState.refreshToken) {
    throw new Error("Auth payload is missing access_token or refresh_token");
  }

  if (cookies.length === 0) {
    throw new Error("Auth payload does not contain cookie_info.cookies");
  }

  return {
    schemaVersion: 1,
    source,
    updatedAt: new Date().toISOString(),
    tokenInfo: {
      mid: authState.mid,
      accessToken: authState.accessToken,
      refreshToken: authState.refreshToken,
      expiresIn: authState.expiresIn,
    },
    cookieInfo: {
      cookies,
    },
    raw: rawData,
  };
}

export function saveBiliAuthBundle({
  rawData,
  source = "unknown",
  authFile = resolveBiliAuthFile(),
  cookieFile = null,
}) {
  const bundle = normalizeBiliAuthBundle(rawData, source);
  const cookieString = buildCookieStringFromBundle(bundle);

  writeFileAtomic(authFile, `${JSON.stringify(bundle, null, 2)}\n`);
  if (typeof cookieFile === "string" && cookieFile.trim()) {
    writeFileAtomic(cookieFile, `${cookieString}\n`);
  }

  return {
    bundle,
    authFile,
    cookieFile,
    cookieString,
  };
}

export async function refreshBiliCookie({
  authFile = resolveBiliAuthFile(),
  cookieFile = null,
  accessToken = null,
  refreshToken = null,
} = {}) {
  const bundle = loadBiliAuthBundle(authFile);
  const storedState = extractBiliAuthState(bundle);
  const finalAccessToken = firstNonEmptyString(accessToken, storedState.accessToken);
  const finalRefreshToken = firstNonEmptyString(refreshToken, storedState.refreshToken);

  if (!finalAccessToken || !finalRefreshToken) {
    throw new Error(`Missing refresh credentials. Expected --access-token/--refresh-token or auth file ${authFile}`);
  }

  const client = new TvQrcodeLogin();
  const response = await client.refresh(finalAccessToken, finalRefreshToken);
  const rawData = response?.data ?? response;
  const saved = saveBiliAuthBundle({
    rawData,
    source: "tv_refresh",
    authFile,
    cookieFile,
  });

  return {
    ...saved,
    response,
  };
}

function writeFileAtomic(targetPath, content) {
  const resolvedPath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, resolvedPath);
}

function findNextAvailableIndexedFileSlot(
  filePath: string,
  {
    existsSync = fs.existsSync,
    readdirSync = fs.readdirSync,
  }: {
    existsSync?: (targetPath: fs.PathLike) => boolean;
    readdirSync?: typeof fs.readdirSync;
  } = {},
) {
  const resolvedPath = path.resolve(filePath);
  const parsedPath = path.parse(resolvedPath);
  let maxSlot = existsSync(resolvedPath) ? 1 : 0;

  if (existsSync(parsedPath.dir)) {
    const siblingPattern = new RegExp(`^${escapeRegExp(parsedPath.name)}_(\\d+)${escapeRegExp(parsedPath.ext)}$`, "u");
    for (const entry of readdirSync(parsedPath.dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const match = siblingPattern.exec(entry.name);
      if (!match) {
        continue;
      }

      const slot = Number(match[1]);
      if (Number.isInteger(slot) && slot > maxSlot) {
        maxSlot = slot;
      }
    }
  }

  return maxSlot + 1 || 1;
}

function buildIndexedSiblingPath(filePath: string, slot: number) {
  const normalizedSlot = normalizeIndexedFileSlot(slot);
  if (normalizedSlot <= 1) {
    return path.resolve(filePath);
  }

  const parsedPath = path.parse(path.resolve(filePath));
  return path.join(parsedPath.dir, `${parsedPath.name}_${normalizedSlot}${parsedPath.ext}`);
}

function normalizeIndexedFileSlot(value: unknown) {
  const resolvedPath = typeof value === "string" ? path.resolve(value) : "";
  if (resolvedPath) {
    const parsedPath = path.parse(resolvedPath);
    const indexedMatch = parsedPath.name.match(/_(\d+)$/u);
    if (indexedMatch) {
      const indexedSlot = Number(indexedMatch[1]);
      if (Number.isInteger(indexedSlot) && indexedSlot > 0) {
        return indexedSlot;
      }
    }
  }

  const numericValue = Number(value);
  if (Number.isInteger(numericValue) && numericValue > 0) {
    return numericValue;
  }

  return 1;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCookieEntries(cookieInfo) {
  const rawCookies = Array.isArray(cookieInfo?.cookies) ? cookieInfo.cookies : [];
  return rawCookies
    .map((item) => ({
      name: String(item?.name ?? "").trim(),
      value: String(item?.value ?? "").trim(),
      httpOnly: Boolean(item?.http_only ?? item?.httpOnly ?? false),
      expires: item?.expires ?? null,
      secure: Boolean(item?.secure ?? false),
    }))
    .filter((item) => item.name && item.value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function firstDefinedNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return null;
}
