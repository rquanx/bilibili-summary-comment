import fs from "node:fs";
import path from "node:path";
import { TvQrcodeLogin } from "@renmu/bili-api";
import { getRepoRoot } from "./runtime-tools.mjs";

const DEFAULT_AUTH_FILE = "work/bili-auth.json";
const DEFAULT_COOKIE_FILE = "cookie.txt";

export function resolveBiliAuthFile(filePath = null) {
  return path.resolve(getRepoRoot(), filePath ?? process.env.BILI_AUTH_FILE ?? DEFAULT_AUTH_FILE);
}

export function resolveBiliCookieFile(filePath = null) {
  return path.resolve(getRepoRoot(), filePath ?? process.env.BILI_COOKIE_FILE ?? DEFAULT_COOKIE_FILE);
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
  cookieFile = resolveBiliCookieFile(),
}) {
  const bundle = normalizeBiliAuthBundle(rawData, source);
  const cookieString = buildCookieStringFromBundle(bundle);

  writeFileAtomic(authFile, `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileAtomic(cookieFile, `${cookieString}\n`);

  return {
    bundle,
    authFile,
    cookieFile,
    cookieString,
  };
}

export async function refreshBiliCookie({
  authFile = resolveBiliAuthFile(),
  cookieFile = resolveBiliCookieFile(),
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
