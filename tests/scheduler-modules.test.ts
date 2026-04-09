import test from "node:test";
import assert from "node:assert/strict";
import { runPipelinesWithConcurrency } from "../scripts/lib/scheduler/concurrency.js";
import { parseSummaryUsers } from "../scripts/lib/scheduler/user-targets.js";
import * as schedulerTasks from "../scripts/lib/scheduler/index.js";
import { cleanupOldWorkDirectories } from "../scripts/lib/scheduler/cleanup.js";
import { runPipelineForBvid } from "../scripts/lib/scheduler/pipeline-runner.js";
import { syncSummaryUsersRecentVideos } from "../scripts/lib/scheduler/uploads.js";

test("parseSummaryUsers deduplicates ids from mixed inputs", () => {
  const users = parseSummaryUsers("123, https://space.bilibili.com/456\n123\ninvalid");

  assert.deepEqual(users, [
    { mid: 123, source: "123" },
    { mid: 456, source: "https://space.bilibili.com/456" },
  ]);
});

test("runPipelinesWithConcurrency keeps per-user work serialized while allowing parallel users", async () => {
  const uploads = [
    { mid: "u1", bvid: "BV1" },
    { mid: "u1", bvid: "BV2" },
    { mid: "u2", bvid: "BV3" },
  ];
  const started = [];
  const finished = [];
  const runningUsers = new Set();

  const result = await runPipelinesWithConcurrency({
    uploads,
    maxConcurrent: 2,
    async runUpload(upload) {
      assert.equal(runningUsers.has(upload.mid), false);
      runningUsers.add(upload.mid);
      started.push(upload.bvid);
      await new Promise((resolve) => setTimeout(resolve, upload.bvid === "BV1" ? 30 : 10));
      finished.push(upload.bvid);
      runningUsers.delete(upload.mid);
      return { ok: true, bvid: upload.bvid };
    },
  });

  assert.deepEqual(result.runs.map((item) => item.bvid), ["BV1", "BV2", "BV3"]);
  assert.deepEqual(result.failures, []);
  assert.equal(started[0], "BV1");
  assert.equal(started[1], "BV3");
  assert.equal(finished.includes("BV2"), true);
});

test("syncSummaryUsersRecentVideos short-circuits cleanly when no users are configured", async () => {
  const result = await syncSummaryUsersRecentVideos({
    summaryUsers: "",
    collectRecentUploadsImpl: async () => ({
      summaryUsers: [],
      uploads: [],
    }),
  });

  assert.deepEqual(result, {
    summaryUsers: [],
    uploads: [],
    runs: [],
    failures: [],
  });
});

test("cleanupOldWorkDirectories removes only safe candidate directories", async () => {
  const removed = [];
  const result = await cleanupOldWorkDirectories({
    dbPath: "ignored.sqlite3",
    workRoot: "work",
    repoRoot: "D:\\repo",
    openDatabaseImpl: () => ({ close() {} }),
    listVideosOlderThanImpl: () => [
      { bvid: "BVsafe", title: "Safe", last_scan_at: "2026-01-01", updated_at: "2026-01-01" },
      { bvid: "..\\escape", title: "Unsafe", last_scan_at: "2026-01-01", updated_at: "2026-01-01" },
    ],
    existsSync(targetPath) {
      return targetPath.endsWith("BVsafe");
    },
    rmSync(targetPath) {
      removed.push(targetPath);
    },
  });

  assert.equal(removed.length, 1);
  assert.equal(removed[0], "D:\\repo\\work\\BVsafe");
  assert.equal(result.removedDirectories.length, 1);
  assert.equal(result.candidates.length, 2);
});

test("runPipelineForBvid launches the TypeScript entry via tsx", async () => {
  const calls = [];

  await runPipelineForBvid({
    cookieFile: "cookie.txt",
    dbPath: "work/pipeline.sqlite3",
    workRoot: "work",
    bvid: "BV1TEST",
    publish: true,
    repoRoot: "D:\\repo",
    async runCommandImpl(command, args) {
      calls.push({ command, args });
      return {
        code: 0,
        stdout: '{"ok":true}',
        stderr: "",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    "--import",
    "tsx",
    "D:\\repo\\scripts\\commands\\run-video-pipeline.ts",
    "--cookie-file",
    "D:\\repo\\cookie.txt",
    "--bvid",
    "BV1TEST",
    "--db",
    "D:\\repo\\work\\pipeline.sqlite3",
    "--work-root",
    "work",
    "--publish",
  ]);
});

test("scheduler-tasks barrel re-exports split modules", () => {
  assert.equal(schedulerTasks.parseSummaryUsers, parseSummaryUsers);
  assert.equal(schedulerTasks.runPipelinesWithConcurrency, runPipelinesWithConcurrency);
  assert.equal(schedulerTasks.cleanupOldWorkDirectories, cleanupOldWorkDirectories);
});
