import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Db } from "./types";
import { initializeDrizzleDb } from "./orm";
import { migrateDatabase } from "./migrations";

const DB_PATH_SYMBOL = Symbol.for("video-pipeline.dbPath");
const DB_WRITE_LOCK_RETRY_MS = 100;
const DB_WRITE_LOCK_TIMEOUT_MS = 60_000;
const DB_WRITE_LOCK_STALE_MS = 30 * 60_000;
const activeWriteLocks = new Map<string, { depth: number; release: () => void }>();

type DbWithPath = Db & {
  [DB_PATH_SYMBOL]?: string;
};

export function openDatabase(databasePath: string): Db {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new BetterSqlite3(resolvedPath) as DbWithPath;
  Object.defineProperty(db, DB_PATH_SYMBOL, {
    value: resolvedPath,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  initializeDrizzleDb(db);

  withDatabaseWriteLock(db, () => {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    migrateDatabase(db);
  });
  return db;
}

export function runInTransaction<T>(db: Pick<Db, "exec">, work: () => T): T {
  return withDatabaseWriteLock(db, () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function withDatabaseWriteLock<T>(dbOrPath: Pick<Db, "exec"> | string, work: () => T): T {
  const resolvedPath = resolveDatabasePath(dbOrPath);
  const active = activeWriteLocks.get(resolvedPath);
  if (active) {
    active.depth += 1;
    try {
      return work();
    } finally {
      releaseActiveWriteLock(resolvedPath);
    }
  }

  const release = acquireDatabaseWriteLock(resolvedPath);
  activeWriteLocks.set(resolvedPath, {
    depth: 1,
    release,
  });

  try {
    return work();
  } finally {
    releaseActiveWriteLock(resolvedPath);
  }
}

function releaseActiveWriteLock(resolvedPath: string) {
  const active = activeWriteLocks.get(resolvedPath);
  if (!active) {
    return;
  }

  active.depth -= 1;
  if (active.depth > 0) {
    return;
  }

  activeWriteLocks.delete(resolvedPath);
  active.release();
}

function resolveDatabasePath(dbOrPath: Pick<Db, "exec"> | string): string {
  if (typeof dbOrPath === "string") {
    return path.resolve(dbOrPath);
  }

  const resolvedPath = (dbOrPath as DbWithPath)[DB_PATH_SYMBOL];
  if (typeof resolvedPath === "string" && resolvedPath) {
    return resolvedPath;
  }

  throw new Error("Database write lock requires a database opened via openDatabase().");
}

function acquireDatabaseWriteLock(resolvedPath: string): () => void {
  const lockDir = `${resolvedPath}.write-lock`;
  const ownerPath = path.join(lockDir, "owner.json");
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        databasePath: resolvedPath,
      }));

      return () => {
        fs.rmSync(lockDir, {
          force: true,
          recursive: true,
        });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (clearStaleDatabaseWriteLock(lockDir, ownerPath)) {
        continue;
      }

      if (Date.now() - startedAt >= DB_WRITE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for database write lock: ${resolvedPath}`);
      }

      sleepSync(DB_WRITE_LOCK_RETRY_MS);
    }
  }
}

function clearStaleDatabaseWriteLock(lockDir: string, ownerPath: string): boolean {
  try {
    const lockStat = fs.statSync(lockDir);
    if (Date.now() - lockStat.mtimeMs < DB_WRITE_LOCK_STALE_MS) {
      return false;
    }

    const owner = readLockOwner(ownerPath);
    if (owner?.pid && isProcessRunning(owner.pid)) {
      return false;
    }

    fs.rmSync(lockDir, {
      force: true,
      recursive: true,
    });
    return true;
  } catch {
    return false;
  }
}

function readLockOwner(ownerPath: string): { pid?: number } | null {
  try {
    const payload = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    return payload && typeof payload === "object" ? payload as { pid?: number } : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ESRCH");
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST");
}

function sleepSync(timeoutMs: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutMs);
}
