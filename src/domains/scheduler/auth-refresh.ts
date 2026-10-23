import path from "node:path";
import { getLastAuthUpdateAt, loadBiliAuthBundle, refreshBiliCookie } from "../bili/auth";
import { findAuthFileForUser } from "./auth-files";
import { parseSummaryUsers } from "./user-targets";

interface RefreshOptions {
  authFile: string;
  summaryUsers: unknown;
  cookieFile?: string | null;
  refreshDays: number;
  force?: boolean;
  now?: number;
  log?: (message: string, options?: { level: "error" }) => void;
  refreshImpl?: typeof refreshBiliCookie;
}

export async function refreshSchedulerAuth({
  authFile, summaryUsers, cookieFile = null, refreshDays, force = false,
  now = Date.now(), log = () => {}, refreshImpl = refreshBiliCookie,
}: RefreshOptions) {
  const baseFile = path.resolve(authFile);
  // Keep refreshing the default credential, including when no users are configured.
  const files = new Set([baseFile]);
  for (const [index] of parseSummaryUsers(summaryUsers).entries()) {
    const mappedFile = findAuthFileForUser(baseFile, index + 1);
    if (mappedFile) files.add(mappedFile);
  }

  const results: Array<{
    authFile: string;
    action: "refresh" | "skip-refresh" | "refresh-failed";
    reason?: string;
    updatedAt?: string;
  }> = [];
  for (const file of files) {
    try {
      const bundle = loadBiliAuthBundle(file);
      if (!bundle) {
        log(`Skip cookie refresh: auth file not found at ${file}`);
        results.push({ authFile: file, action: "skip-refresh", reason: "auth-file-missing" });
        continue;
      }
      const timestamp = getLastAuthUpdateAt(bundle);
      const updatedAt = timestamp ? new Date(timestamp).getTime() : NaN;
      const due = !Number.isFinite(updatedAt)
        || now - updatedAt >= Math.max(1, Number(refreshDays) || 30) * 86_400_000;
      if (!force && !due) {
        log(`Skip cookie refresh: ${file} is newer than ${refreshDays} days`);
        results.push({ authFile: file, action: "skip-refresh", reason: "not-due" });
        continue;
      }
      log(`Refreshing Bilibili cookie via TV refresh token: ${file}`);
      const result = await refreshImpl({
        authFile: file,
        // The legacy cookie output belongs only to the default credential.
        cookieFile: file === baseFile ? cookieFile : null,
      });
      log(`Cookie refresh completed: ${file} (${result.bundle.updatedAt})`);
      results.push({ authFile: file, action: "refresh", updatedAt: result.bundle.updatedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log(`Cookie refresh failed: ${file}: ${message}`, { level: "error" });
      results.push({ authFile: file, action: "refresh-failed", reason: message });
    }
  }
  return {
    action: "refresh-sweep",
    refreshed: results.filter((result) => result.action === "refresh").length,
    failures: results.filter((result) => result.action === "refresh-failed").length,
    results,
  };
}
