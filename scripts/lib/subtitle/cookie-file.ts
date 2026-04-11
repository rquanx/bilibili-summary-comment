import fs from "node:fs";
import path from "node:path";
import { firstNonEmptyString } from "./utils";

export function ensureYtDlpCookieFile({ workDir, cookie, cookieFile }) {
  const resolvedCookieFile = resolveCookieFile(cookieFile);
  if (resolvedCookieFile) {
    const rawCookieFile = fs.readFileSync(resolvedCookieFile, "utf8").replace(/^\uFEFF/, "").trim();
    if (isNetscapeCookieJar(rawCookieFile)) {
      return resolvedCookieFile;
    }
  }

  const cookieHeader = firstNonEmptyString(
    cookie,
    resolvedCookieFile ? fs.readFileSync(resolvedCookieFile, "utf8") : null,
  );
  if (!cookieHeader) {
    return null;
  }

  const cookieJarPath = path.join(workDir, "yt-dlp-cookies.txt");
  fs.writeFileSync(cookieJarPath, convertCookieHeaderToNetscape(cookieHeader), "utf8");
  return cookieJarPath;
}

function resolveCookieFile(cookieFile) {
  if (typeof cookieFile !== "string" || !cookieFile.trim()) {
    return null;
  }

  const resolvedPath = path.resolve(cookieFile);
  return fs.existsSync(resolvedPath) ? resolvedPath : null;
}

function isNetscapeCookieJar(content) {
  const trimmed = String(content ?? "").trim();
  return trimmed.startsWith("# Netscape HTTP Cookie File");
}

function convertCookieHeaderToNetscape(cookieHeader) {
  const lines = ["# Netscape HTTP Cookie File", "# This file is generated from the project's cookie header."];

  for (const part of String(cookieHeader ?? "").split(";")) {
    const trimmedPart = part.trim();
    if (!trimmedPart) {
      continue;
    }

    const separatorIndex = trimmedPart.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmedPart.slice(0, separatorIndex).trim();
    const value = trimmedPart.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    lines.push([".bilibili.com", "TRUE", "/", "FALSE", "2147483647", name, value].join("\t"));
  }

  return `${lines.join("\n")}\n`;
}
