import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupStaleRuntimeLocks } from "../src/shared/runtime-locks";

test("cleanupStaleRuntimeLocks removes stale work locks and database write locks on startup", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-runtime-locks-"));
  const staleTime = Date.now() - (15 * 60_000);
  const workLockPath = path.join(tempRoot, "work", ".locks", "video-pipeline-BVSTALE.lock");
  const dbLockPath = path.join(tempRoot, "work", "pipeline.sqlite3.write-lock");

  try {
    fs.mkdirSync(workLockPath, { recursive: true });
    fs.writeFileSync(path.join(workLockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: "old-container",
      bvid: "BVSTALE",
      updatedAt: new Date(staleTime).toISOString(),
    }), "utf8");
    fs.utimesSync(path.join(workLockPath, "owner.json"), staleTime / 1000, staleTime / 1000);

    fs.mkdirSync(dbLockPath, { recursive: true });
    fs.writeFileSync(path.join(dbLockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: "old-container",
      createdAt: new Date(staleTime).toISOString(),
    }), "utf8");
    fs.utimesSync(path.join(dbLockPath, "owner.json"), staleTime / 1000, staleTime / 1000);

    const result = cleanupStaleRuntimeLocks({
      repoRoot: tempRoot,
      workRoot: "work",
      dbPath: "work/pipeline.sqlite3",
      currentHostname: "new-container",
      nowMs: Date.now(),
    });

    assert.equal(fs.existsSync(workLockPath), false);
    assert.equal(fs.existsSync(dbLockPath), false);
    assert.deepEqual(
      result.removed.map((entry) => entry.name).sort(),
      ["pipeline.sqlite3.write-lock", "video-pipeline-BVSTALE.lock"],
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("cleanupStaleRuntimeLocks keeps fresh locks from another hostname", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-runtime-locks-keep-"));
  const workLockPath = path.join(tempRoot, "work", ".locks", "videocaptioner-asr.lock");

  try {
    fs.mkdirSync(workLockPath, { recursive: true });
    fs.writeFileSync(path.join(workLockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      hostname: "other-container",
      engine: "faster-whisper",
      updatedAt: new Date().toISOString(),
    }), "utf8");

    const result = cleanupStaleRuntimeLocks({
      repoRoot: tempRoot,
      workRoot: "work",
      dbPath: "work/pipeline.sqlite3",
      currentHostname: "new-container",
      nowMs: Date.now(),
    });

    assert.equal(fs.existsSync(workLockPath), true);
    assert.deepEqual(result.removed, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
