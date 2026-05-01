import { randomUUID } from "node:crypto";
import { TvQrcodeLogin } from "@renmu/bili-api";
import { resolveBiliLoginOutputFiles, saveBiliAuthBundle } from "../../../scripts/lib/bili/auth";

export type BiliLoginSessionStatus = "pending" | "scanned" | "completed" | "failed" | "cancelled";

export interface BiliLoginSessionSnapshot {
  id: string;
  status: BiliLoginSessionStatus;
  authFile: string;
  cookieFile: string | null;
  loginUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  mid: number | null;
}

export function createBiliLoginService() {
  const sessions = new Map<string, {
    snapshot: BiliLoginSessionSnapshot;
    client: TvQrcodeLogin | null;
  }>();

  return {
    close() {
      for (const entry of sessions.values()) {
        entry.client?.interrupt?.();
      }
      sessions.clear();
    },
    async startSession({
      authFile,
      cookieFile,
    }: {
      authFile?: string;
      cookieFile?: string | null;
    } = {}) {
      const outputFiles = resolveBiliLoginOutputFiles({
        authFile: typeof authFile === "string" && authFile.trim() ? authFile : null,
        cookieFile: typeof cookieFile === "string" && cookieFile.trim() ? cookieFile : null,
      });
      const client = new TvQrcodeLogin();
      const now = new Date().toISOString();
      const snapshot: BiliLoginSessionSnapshot = {
        id: randomUUID(),
        status: "pending",
        authFile: outputFiles.authFile,
        cookieFile: outputFiles.cookieFile,
        loginUrl: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        errorMessage: null,
        mid: null,
      };
      sessions.set(snapshot.id, {
        snapshot,
        client,
      });

      client.on("scan", () => {
        updateSessionSnapshot(snapshot.id, sessions, {
          status: "scanned",
          errorMessage: null,
        });
      });
      client.once("completed", (response) => {
        try {
          const rawData = response?.data ?? response;
          const saved = saveBiliAuthBundle({
            rawData,
            source: "tv_qrcode_login",
            authFile: outputFiles.authFile,
            cookieFile: outputFiles.cookieFile,
          });
          updateSessionSnapshot(snapshot.id, sessions, {
            status: "completed",
            completedAt: new Date().toISOString(),
            errorMessage: null,
            mid: Number.isInteger(Number(saved.bundle.tokenInfo.mid)) ? Number(saved.bundle.tokenInfo.mid) : null,
          });
        } catch (error) {
          updateSessionSnapshot(snapshot.id, sessions, {
            status: "failed",
            completedAt: new Date().toISOString(),
            errorMessage: error instanceof Error ? error.message : "Failed to save login bundle",
          });
        } finally {
          const session = sessions.get(snapshot.id);
          if (session) {
            session.client = null;
          }
        }
      });
      client.once("error", (response) => {
        updateSessionSnapshot(snapshot.id, sessions, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errorMessage: String(response?.message ?? "Bilibili TV login failed"),
        });
        const session = sessions.get(snapshot.id);
        if (session) {
          session.client = null;
        }
      });

      const loginUrl = await client.login();
      updateSessionSnapshot(snapshot.id, sessions, {
        loginUrl,
      });

      return getSessionSnapshot(snapshot.id, sessions);
    },
    getSession(sessionId: string) {
      return getSessionSnapshot(sessionId, sessions);
    },
    cancelSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) {
        return null;
      }

      session.client?.interrupt?.();
      session.client = null;
      updateSessionSnapshot(sessionId, sessions, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        errorMessage: null,
      });

      return getSessionSnapshot(sessionId, sessions);
    },
  };
}

function getSessionSnapshot(
  sessionId: string,
  sessions: Map<string, { snapshot: BiliLoginSessionSnapshot; client: TvQrcodeLogin | null }>,
) {
  const session = sessions.get(sessionId);
  return session ? { ...session.snapshot } : null;
}

function updateSessionSnapshot(
  sessionId: string,
  sessions: Map<string, { snapshot: BiliLoginSessionSnapshot; client: TvQrcodeLogin | null }>,
  patch: Partial<BiliLoginSessionSnapshot>,
) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  session.snapshot = {
    ...session.snapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}
