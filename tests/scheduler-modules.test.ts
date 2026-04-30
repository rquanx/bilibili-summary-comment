import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { listPendingPublishParts, listVideosPendingPublish, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { resolveAuthFileForUser } from "../scripts/lib/scheduler/auth-files";
import { createCoalescedRunner } from "../scripts/lib/scheduler/coalesced-runner";
import { runPipelinesWithConcurrency } from "../scripts/lib/scheduler/concurrency";
import { resolveCookieFileForUser } from "../scripts/lib/scheduler/cookie-files";
import { parseSummaryUsers } from "../scripts/lib/scheduler/user-targets";
import * as schedulerTasks from "../scripts/lib/scheduler/index";
import { cleanupOldWorkDirectories } from "../scripts/lib/scheduler/cleanup";
import {
  detectGapsFromVideoSnapshot,
  readGapCheckDailySnapshot,
  runRecentVideoGapCheck,
  upsertGapCheckDailySnapshot,
} from "../scripts/lib/scheduler/gap-check";
import { runPipelineForBvid } from "../scripts/lib/scheduler/pipeline-runner";
import { runPendingVideoPublishSweep } from "../scripts/lib/scheduler/publish";
import { collectRecentUploadsFromUsers, syncSummaryUsersRecentVideos } from "../scripts/lib/scheduler/uploads";
import { compareTimestampDesc, formatEast8DateTime } from "../scripts/lib/shared/time";

test("parseSummaryUsers deduplicates ids from mixed inputs", () => {
  const users = parseSummaryUsers("123, https://space.bilibili.com/456\n123\ninvalid");

  assert.deepEqual(users, [
    { mid: 123, source: "123" },
    { mid: 456, source: "https://space.bilibili.com/456" },
  ]);
});

test("resolveCookieFileForUser falls back from indexed cookie to cookie_1 then base cookie", () => {
  assert.equal(resolveCookieFileForUser("cookie.txt", 2, {
    repoRoot: "D:\\repo",
    existsSync(targetPath) {
      return targetPath === "D:\\repo\\cookie_1.txt";
    },
  }), "D:\\repo\\cookie_1.txt");

  assert.equal(resolveCookieFileForUser("cookie.txt", 3, {
    repoRoot: "D:\\repo",
    existsSync(targetPath) {
      return targetPath === "D:\\repo\\cookie.txt";
    },
  }), "D:\\repo\\cookie.txt");
});

test("resolveAuthFileForUser falls back from indexed auth to auth_1 then base auth", () => {
  assert.equal(resolveAuthFileForUser(".auth/bili-auth.json", 2, {
    repoRoot: "D:\\repo",
    existsSync(targetPath) {
      return targetPath === "D:\\repo\\.auth\\bili-auth_1.json";
    },
  }), "D:\\repo\\.auth\\bili-auth_1.json");

  assert.equal(resolveAuthFileForUser(".auth/bili-auth.json", 3, {
    repoRoot: "D:\\repo",
    existsSync(targetPath) {
      return targetPath === "D:\\repo\\.auth\\bili-auth.json";
    },
  }), "D:\\repo\\.auth\\bili-auth.json");
});

test("resolveCookieFileForUser throws when no candidate cookie file exists", () => {
  assert.throws(
    () =>
      resolveCookieFileForUser("cookie.txt", 2, {
        repoRoot: "D:\\repo",
        existsSync() {
          return false;
        },
      }),
    /Missing cookie file for summary user #2/u,
  );
});

test("resolveAuthFileForUser throws when no candidate auth file exists", () => {
  assert.throws(
    () =>
      resolveAuthFileForUser(".auth/bili-auth.json", 2, {
        repoRoot: "D:\\repo",
        existsSync() {
          return false;
        },
      }),
    /Missing auth file for summary user #2/u,
  );
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

test("syncSummaryUsersRecentVideos forwards publish=false to pipeline runs", async () => {
  const observedPublishFlags: boolean[] = [];

  await syncSummaryUsersRecentVideos({
    summaryUsers: "123",
    publish: false,
    collectRecentUploadsImpl: async () => ({
      summaryUsers: [{ mid: 123, source: "123" }],
      uploads: [
        {
          mid: 123,
          bvid: "BVNOPUBLISH",
          aid: 1,
          title: "No Publish",
          authFile: "D:\\repo\\.auth\\bili-auth_1.json",
          createdAtUnix: 100,
          createdAt: new Date(100 * 1000).toISOString(),
          source: "123",
        },
      ],
    }),
    async runPipelinesWithConcurrencyImpl(options) {
      for (const upload of options.uploads ?? []) {
        await options.runUpload?.(upload);
      }

      return {
        runs: [],
        failures: [],
      };
    },
    async runPipelineForBvidImpl(options) {
      observedPublishFlags.push(Boolean(options.publish));
      return {
        ok: true,
      };
    },
  });

  assert.deepEqual(observedPublishFlags, [false]);
});

test("syncSummaryUsersRecentVideos keeps same-user title variants and queues earliest variants first for reuse", async () => {
  const logMessages: string[] = [];
  const scheduledUploads: Array<{ bvid: string; title: string }> = [];
  const observedSchedulingKeys: string[] = [];

  const result = await syncSummaryUsersRecentVideos({
    summaryUsers: "123",
    collectRecentUploadsImpl: async () => ({
      summaryUsers: [{ mid: 123, source: "123" }],
      uploads: [
        {
          mid: 123,
          bvid: "BVDANMU",
          aid: 1,
          title: "直播回放 弹幕版",
          createdAtUnix: 200,
          createdAt: new Date(200 * 1000).toISOString(),
          source: "123",
        },
        {
          mid: 123,
          bvid: "BVCLEAN",
          aid: 2,
          title: "直播回放 纯净版",
          createdAtUnix: 100,
          createdAt: new Date(100 * 1000).toISOString(),
          source: "123",
        },
        {
          mid: 123,
          bvid: "BVPLAIN",
          aid: 3,
          title: "另一个视频",
          createdAtUnix: 150,
          createdAt: new Date(150 * 1000).toISOString(),
          source: "123",
        },
      ],
    }),
    async runPipelinesWithConcurrencyImpl(options) {
      for (const upload of options.uploads ?? []) {
        scheduledUploads.push({
          bvid: String(upload.bvid),
          title: String(upload.title),
        });
        observedSchedulingKeys.push(String(options.userKeyForUpload?.(upload)));
      }

      return {
        runs: [],
        failures: [],
      };
    },
    onLog(message) {
      logMessages.push(message);
    },
  });

  assert.deepEqual(result.uploads.map((item) => item.bvid), ["BVCLEAN", "BVDANMU", "BVPLAIN"]);
  assert.deepEqual(scheduledUploads.map((item) => item.bvid), ["BVCLEAN", "BVDANMU", "BVPLAIN"]);
  assert.equal(
    logMessages.includes(
      "Queue 2 same-session variants serially for subtitle/summary/comment reuse: BVCLEAN -> BVDANMU",
    ),
    true,
  );
  assert.equal(
    logMessages.includes("Running up to 3 pipelines concurrently with variant-aware serialization"),
    true,
  );
  assert.equal(observedSchedulingKeys[0], observedSchedulingKeys[1]);
  assert.notEqual(observedSchedulingKeys[1], observedSchedulingKeys[2]);
});

test("syncSummaryUsersRecentVideos serializes related variants under the same session key", async () => {
  const observedKeys: string[] = [];

  await syncSummaryUsersRecentVideos({
    summaryUsers: "123",
    collectRecentUploadsImpl: async () => ({
      summaryUsers: [{ mid: 123, source: "123" }],
      uploads: [
        {
          mid: 123,
          bvid: "BV1",
          aid: 1,
          title: "直播A 弹幕版",
          createdAtUnix: 100,
          createdAt: new Date(100 * 1000).toISOString(),
          source: "123",
        },
        {
          mid: 123,
          bvid: "BV2",
          aid: 2,
          title: "直播A 纯净版",
          createdAtUnix: 90,
          createdAt: new Date(90 * 1000).toISOString(),
          source: "123",
        },
        {
          mid: 123,
          bvid: "BV3",
          aid: 3,
          title: "视频二",
          createdAtUnix: 80,
          createdAt: new Date(80 * 1000).toISOString(),
          source: "123",
        },
      ],
    }),
    async runPipelinesWithConcurrencyImpl(options) {
      observedKeys.push(...(options.uploads ?? []).map((upload) => String(options.userKeyForUpload?.(upload))));

      return {
        runs: [],
        failures: [],
      };
    },
  });

  assert.deepEqual(observedKeys, ["123\n直播a", "123\n直播a", "123\n视频二"]);
});

test("syncSummaryUsersRecentVideos does not force clean variants ahead of earlier danmu uploads", async () => {
  const scheduledBvids: string[] = [];

  await syncSummaryUsersRecentVideos({
    summaryUsers: "123",
    collectRecentUploadsImpl: async () => ({
      summaryUsers: [{ mid: 123, source: "123" }],
      uploads: [
        {
          mid: 123,
          bvid: "BVCLEAN",
          aid: 1,
          title: "直播B 纯净版",
          createdAtUnix: 120,
          createdAt: new Date(120 * 1000).toISOString(),
          source: "123",
        },
        {
          mid: 123,
          bvid: "BVDANMU",
          aid: 2,
          title: "直播B 弹幕版",
          createdAtUnix: 60,
          createdAt: new Date(60 * 1000).toISOString(),
          source: "123",
        },
      ],
    }),
    async runPipelinesWithConcurrencyImpl(options) {
      scheduledBvids.push(...(options.uploads ?? []).map((upload) => String(upload.bvid)));
      return {
        runs: [],
        failures: [],
      };
    },
  });

  assert.deepEqual(scheduledBvids, ["BVDANMU", "BVCLEAN"]);
});

test("collectRecentUploadsFromUsers skips only-self-visible videos", async () => {
  const logMessages: string[] = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  const result = await collectRecentUploadsFromUsers({
    summaryUsers: "123",
    findAuthFileForUserImpl() {
      return path.resolve(".auth", "bili-auth.json");
    },
    readCookieStringFromAuthFileImpl: () => "SESSDATA=fake",
    createClientImpl: (() => ({
      user: {
        async getVideos() {
          return {
            list: {
              vlist: [
                {
                  aid: 1,
                  bvid: "BVVISIBLE",
                  title: "Visible",
                  created: nowUnix,
                  is_self_view: false,
                },
                {
                  aid: 2,
                  bvid: "BVPRIVATE",
                  title: "Private",
                  created: nowUnix,
                  is_self_view: true,
                },
                {
                  aid: 3,
                  bvid: "BVPRIVATE2",
                  title: "Private Legacy",
                  created: nowUnix,
                  is_only_self: 1,
                },
              ],
            },
          };
        },
      },
    })) as any,
    onLog(message) {
      logMessages.push(message);
    },
  });

  assert.deepEqual(result.uploads.map((item) => item.bvid), ["BVVISIBLE"]);
  assert.deepEqual(logMessages, [
    "Fetching recent uploads for uid 123",
    "Skip only-self-visible video BVPRIVATE (Private)",
    "Skip only-self-visible video BVPRIVATE2 (Private Legacy)",
  ]);
});

test("collectRecentUploadsFromUsers skips users blocked by Bilibili risk control", async () => {
  const logMessages: string[] = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  const result = await collectRecentUploadsFromUsers({
    summaryUsers: "123,456",
    findAuthFileForUserImpl(_authFile, userIndex) {
      return path.resolve(".auth", `bili-auth_${userIndex}.json`);
    },
    readCookieStringFromAuthFileImpl: () => "SESSDATA=fake",
    createClientImpl: (() => ({
      user: {
        async getVideos({ mid }) {
          if (Number(mid) === 123) {
            const error = new Error("风控校验失败") as Error & {
              code?: number;
              rawResponse?: {
                data?: {
                  code?: number;
                  message?: string;
                };
              };
            };
            error.code = -352;
            error.rawResponse = {
              data: {
                code: -352,
                message: "风控校验失败",
              },
            };
            throw error;
          }

          return {
            list: {
              vlist: [
                {
                  aid: Number(mid),
                  bvid: `BV${mid}`,
                  title: `Video ${mid}`,
                  created: nowUnix,
                },
              ],
            },
          };
        },
      },
    })) as any,
    onLog(message) {
      logMessages.push(message);
    },
  });

  assert.deepEqual(result.uploads.map((item) => item.bvid), ["BV456"]);
  assert.deepEqual(logMessages, [
    "Fetching recent uploads for uid 123",
    "Skip uid 123: recent upload fetch blocked by Bilibili risk control (风控校验失败)",
    "Fetching recent uploads for uid 456",
  ]);
});

test("collectRecentUploadsFromUsers still throws non-risk-control fetch failures", async () => {
  await assert.rejects(
    () =>
      collectRecentUploadsFromUsers({
        summaryUsers: "123",
        findAuthFileForUserImpl() {
          return path.resolve(".auth", "bili-auth.json");
        },
        readCookieStringFromAuthFileImpl: () => "SESSDATA=fake",
        createClientImpl: (() => ({
          user: {
            async getVideos() {
              throw new Error("network timeout");
            },
          },
        })) as any,
      }),
    /Failed to fetch recent uploads for uid 123: network timeout/u,
  );
});

test("collectRecentUploadsFromUsers uses per-user indexed auth files", async () => {
  const authReads: string[] = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  const result = await collectRecentUploadsFromUsers({
    summaryUsers: "123,456",
    authFile: ".auth/bili-auth.json",
    findAuthFileForUserImpl(_authFile, userIndex) {
      return path.resolve(".auth", `bili-auth_${userIndex}.json`);
    },
    readCookieStringFromAuthFileImpl(authFile) {
      authReads.push(authFile);
      return `auth:${path.basename(authFile)}`;
    },
    createClientImpl: ((cookieHeader: string) => ({
      user: {
        async getVideos({ mid }) {
          return {
            list: {
              vlist: [
                {
                  aid: Number(mid),
                  bvid: `BV${mid}`,
                  title: cookieHeader,
                  created: nowUnix,
                },
              ],
            },
          };
        },
      },
    })) as any,
  });

  assert.deepEqual(authReads, [
    path.resolve(".auth", "bili-auth_1.json"),
    path.resolve(".auth", "bili-auth_2.json"),
  ]);
  assert.deepEqual(
    result.uploads.map((item) => ({
      bvid: item.bvid,
      authFile: item.authFile,
      title: item.title,
    })),
    [
      {
        bvid: "BV123",
        authFile: path.resolve(".auth", "bili-auth_1.json"),
        title: "auth:bili-auth_1.json",
      },
      {
        bvid: "BV456",
        authFile: path.resolve(".auth", "bili-auth_2.json"),
        title: "auth:bili-auth_2.json",
      },
    ],
  );
});

test("detectGapsFromVideoSnapshot flags only intervals larger than the threshold", () => {
  const gaps = detectGapsFromVideoSnapshot({
    bvid: "BV1GAPTEST",
    title: "Gap Test Video",
    pages: [
      {
        pageNo: 1,
        cid: 101,
        partTitle: "Gap Test 2026.04.12 01.00.00",
        durationSec: 10,
      },
      {
        pageNo: 2,
        cid: 202,
        partTitle: "Gap Test 2026.04.12 01.00.12",
        durationSec: 10,
      },
      {
        pageNo: 3,
        cid: 303,
        partTitle: "Gap Test 2026.04.12 01.00.30",
        durationSec: 5,
      },
    ],
  }, 5);

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fromPageNo, 2);
  assert.equal(gaps[0].toPageNo, 3);
  assert.equal(gaps[0].gapSeconds, 8);
});

test("upsertGapCheckDailySnapshot keeps only the latest record per bvid for the day", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-gap-snapshot-"));
  const now = new Date("2026-04-12T01:00:00.000Z");

  try {
    const snapshotPath = upsertGapCheckDailySnapshot({
      repoRoot: tempRoot,
      workRoot: "work",
      now,
      videoRecord: {
        bvid: "BV1SNAP",
        title: "First Title",
        checkedAt: "2026-04-12T01:00:00.000Z",
        gapCount: 1,
        gaps: [
          {
            gapKey: "gap-1",
            bvid: "BV1SNAP",
            title: "First Title",
            fromPageNo: 1,
            fromCid: 101,
            fromPartTitle: "P1",
            fromEndAt: "2026-04-12 01:00:10",
            toPageNo: 2,
            toCid: 202,
            toPartTitle: "P2",
            toStartAt: "2026-04-12 01:00:20",
            gapSeconds: 10,
          },
        ],
      },
    });

    upsertGapCheckDailySnapshot({
      repoRoot: tempRoot,
      workRoot: "work",
      now: new Date("2026-04-12T02:00:00.000Z"),
      videoRecord: {
        bvid: "BV1SNAP",
        title: "Updated Title",
        checkedAt: "2026-04-12T02:00:00.000Z",
        gapCount: 0,
        gaps: [],
      },
    });

    const snapshot = readGapCheckDailySnapshot(snapshotPath, "2026-04-12");
    assert.equal(snapshot.videos.length, 1);
    assert.equal(snapshot.videos[0].title, "Updated Title");
    assert.equal(snapshot.videos[0].gapCount, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compareTimestampDesc supports East-8 human-readable timestamps", () => {
  assert.equal(compareTimestampDesc("2026-04-12 12:00:00", "2026-04-12 11:59:59") < 0, true);
  assert.equal(compareTimestampDesc("2026-04-12 11:59:59", "2026-04-12 12:00:00") > 0, true);
  assert.equal(compareTimestampDesc("2026-04-12 12:00:00", "2026-04-12T04:00:00.000Z"), 0);
});

test("runRecentVideoGapCheck sends notifications only for previously unseen gaps", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-gap-run-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const notifyCalls: Array<string[]> = [];
  const snapshot = {
    bvid: "BV1RUN",
    aid: 1,
    title: "Gap Run Test",
    pageCount: 2,
    pages: [
      {
        pageNo: 1,
        cid: 101,
        partTitle: "Gap Run 2026.04.12 01.00.00",
        durationSec: 10,
      },
      {
        pageNo: 2,
        cid: 202,
        partTitle: "Gap Run 2026.04.12 01.00.20",
        durationSec: 10,
      },
    ],
  };

  try {
    openDatabase(dbPath).close?.();

    const runOptions = {
      summaryUsers: "123",
      authFile: ".auth/bili-auth.json",
      dbPath,
      workRoot: "work",
      repoRoot: tempRoot,
      now: new Date("2026-04-12T03:00:00.000Z"),
      collectRecentUploadsImpl: async () => ({
        summaryUsers: [{ mid: 123, source: "123" }],
        uploads: [
          {
            mid: 123,
            bvid: "BV1RUN",
            aid: 1,
            title: "Gap Run Test",
            authFile: path.join(tempRoot, ".auth", "bili-auth.json"),
            createdAtUnix: 1,
            createdAt: "2026-04-12T01:00:00.000Z",
            source: "123",
          },
        ],
      }),
      readCookieStringFromAuthFileImpl: () => "SESSDATA=fake",
      createClientImpl: (() => ({})) as any,
      fetchVideoSnapshotImpl: async () => snapshot,
      notifyNewGapsImpl: async ({ gaps }) => {
        notifyCalls.push(gaps.map((gap) => gap.gapKey));
        return {
          sent: true,
          skipped: false,
        } as const;
      },
    };

    const firstRun = await runRecentVideoGapCheck(runOptions);
    const secondRun = await runRecentVideoGapCheck({
      ...runOptions,
      now: new Date("2026-04-12T04:00:00.000Z"),
    });

    assert.equal(firstRun.newGaps.length, 1);
    assert.equal(firstRun.notifiedGapCount, 1);
    assert.equal(secondRun.newGaps.length, 0);
    assert.equal(secondRun.alreadyNotifiedGapCount, 1);
    assert.deepEqual(notifyCalls, [[firstRun.checkedVideos[0].gaps[0].gapKey]]);

    const snapshotPath = path.join(tempRoot, "work", "logs", "gap-check", "2026-04-12.json");
    const dailySnapshot = readGapCheckDailySnapshot(snapshotPath, "2026-04-12");
    assert.equal(dailySnapshot.videos.length, 1);
    assert.equal(dailySnapshot.videos[0].checkedAt, formatEast8DateTime(new Date("2026-04-12T04:00:00.000Z")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runRecentVideoGapCheck uses the upload-specific auth file when present", async () => {
  const authReads: string[] = [];
  const observedClients: string[] = [];

  const result = await runRecentVideoGapCheck({
    summaryUsers: "123,456",
    authFile: ".auth/bili-auth.json",
    dbPath: path.join(os.tmpdir(), `pipeline-${Date.now()}-auth.sqlite3`),
    workRoot: "work",
    repoRoot: "D:\\repo",
    collectRecentUploadsImpl: async () => ({
      summaryUsers: [
        { mid: 123, source: "123" },
        { mid: 456, source: "456" },
      ],
      uploads: [
        {
          mid: 123,
          bvid: "BV1",
          aid: 1,
          title: "Video 1",
          authFile: "D:\\repo\\.auth\\bili-auth_1.json",
          createdAtUnix: 2,
          createdAt: "2026-04-12T01:00:00.000Z",
          source: "123",
        },
        {
          mid: 456,
          bvid: "BV2",
          aid: 2,
          title: "Video 2",
          authFile: "D:\\repo\\.auth\\bili-auth_2.json",
          createdAtUnix: 1,
          createdAt: "2026-04-12T00:00:00.000Z",
          source: "456",
        },
      ],
    }),
    readCookieStringFromAuthFileImpl(authFile) {
      authReads.push(String(authFile));
      return `auth:${path.basename(String(authFile))}`;
    },
    createClientImpl: ((cookieHeader: string) => ({ cookieHeader })) as any,
    fetchVideoSnapshotImpl: async (client, { bvid }) => {
      observedClients.push(String((client as { cookieHeader?: string }).cookieHeader));
      return {
        bvid: String(bvid),
        aid: 1,
        title: String(bvid),
        pageCount: 1,
        pages: [
          {
            pageNo: 1,
            cid: 101,
            partTitle: "Gap Run 2026.04.12 01.00.00",
            durationSec: 10,
          },
        ],
      };
    },
    notifyNewGapsImpl: async () => ({
      sent: false,
      skipped: true,
      reason: "empty-gaps",
    }) as const,
  });

  assert.equal(result.checkedVideos.length, 2);
  assert.deepEqual(authReads, ["D:\\repo\\.auth\\bili-auth_1.json", "D:\\repo\\.auth\\bili-auth_2.json"]);
  assert.deepEqual(observedClients, ["auth:bili-auth_1.json", "auth:bili-auth_2.json"]);
});

test("createCoalescedRunner reruns once after overlapping triggers while work is in progress", async () => {
  const runningTasks = new Set<string>();
  const logMessages: string[] = [];
  const waiters: Array<() => void> = [];
  let runCount = 0;

  const runner = createCoalescedRunner({
    name: "summary",
    runningTasks,
    onLog(message) {
      logMessages.push(message);
    },
    async task() {
      runCount += 1;
      const currentRun = runCount;
      if (currentRun === 1) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }

      return {
        runCount: currentRun,
      };
    },
  });

  const firstRun = runner();
  const queuedRunA = runner();
  const queuedRunB = runner();

  assert.equal(runningTasks.has("summary"), true);
  waiters.shift()?.();

  assert.equal(await queuedRunA, null);
  assert.equal(await queuedRunB, null);
  assert.deepEqual(await firstRun, { runCount: 2 });
  assert.equal(runCount, 2);
  assert.equal(runningTasks.has("summary"), false);
  assert.deepEqual(logMessages, [
    "Queue summary: previous run still in progress; will rerun immediately after completion",
    "Queue summary: previous run still in progress; will rerun immediately after completion",
    "Running queued summary rerun",
  ]);
});

test("createCoalescedRunner can queue another rerun while the queued rerun is running", async () => {
  const runningTasks = new Set<string>();
  let runCount = 0;
  let resolveFirstRun: (() => void) | null = null;
  let resolveSecondRun: (() => void) | null = null;
  let markSecondRunStarted: (() => void) | null = null;
  const firstRunGate = new Promise<void>((resolve) => {
    resolveFirstRun = resolve;
  });
  const secondRunGate = new Promise<void>((resolve) => {
    resolveSecondRun = resolve;
  });
  const secondRunStarted = new Promise<void>((resolve) => {
    markSecondRunStarted = resolve;
  });

  const runner = createCoalescedRunner({
    name: "summary",
    runningTasks,
    async task() {
      runCount += 1;
      const currentRun = runCount;
      if (currentRun === 1) {
        await firstRunGate;
      }

      if (currentRun === 2) {
        markSecondRunStarted?.();
        await secondRunGate;
      }

      return currentRun;
    },
  });

  const firstRun = runner();
  await Promise.resolve();
  const queuedRun = runner();

  resolveFirstRun?.();
  await secondRunStarted;
  const queuedDuringRerun = runner();
  resolveSecondRun?.();

  assert.equal(await queuedRun, null);
  assert.equal(await queuedDuringRerun, null);
  assert.equal(await firstRun, 3);
  assert.equal(runCount, 3);
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
      return targetPath === "D:\\repo\\work\\BVsafe";
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

test("runPipelineForBvid launches the compiled JavaScript entry directly when dist files exist", async () => {
  const calls = [];
  const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-dist-"));
  const compiledEntryPath = path.join(tempRepoRoot, "scripts", "commands", "run-video-pipeline.js");

  fs.mkdirSync(path.dirname(compiledEntryPath), { recursive: true });
  fs.writeFileSync(compiledEntryPath, "export {};\n", "utf8");

  try {
    await runPipelineForBvid({
      cookieFile: "cookie.txt",
      dbPath: "work/pipeline.sqlite3",
      workRoot: "work",
      bvid: "BV1DIST",
      publish: false,
      repoRoot: tempRepoRoot,
      async runCommandImpl(command, args) {
        calls.push({ command, args });
        return {
          code: 0,
          stdout: '{"ok":true}',
          stderr: "",
        };
      },
    });
  } finally {
    fs.rmSync(tempRepoRoot, { recursive: true, force: true });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    compiledEntryPath,
    "--cookie-file",
    path.join(tempRepoRoot, "cookie.txt"),
    "--bvid",
    "BV1DIST",
    "--db",
    path.join(tempRepoRoot, "work", "pipeline.sqlite3"),
    "--work-root",
    "work",
  ]);
});

test("runPipelineForBvid appends the video link to command failures", async () => {
  await assert.rejects(
    () =>
      runPipelineForBvid({
        cookieFile: "cookie.txt",
        dbPath: "work/pipeline.sqlite3",
        workRoot: "work",
        bvid: "BV1FAILURL",
        publish: true,
        repoRoot: "D:\\repo",
        async runCommandImpl() {
          const error = new Error("child failed") as Error & { stdout?: string };
          error.stdout = JSON.stringify({
            ok: false,
            message: "Publish failed",
            videoUrl: "https://www.bilibili.com/video/BV1FAILURL",
          });
          throw error;
        },
      }),
    /https:\/\/www\.bilibili\.com\/video\/BV1FAILURL/u,
  );
});

test("listVideosPendingPublish returns append work before rebuild work", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-publish-list-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const appendVideo = upsertVideo(db, {
      bvid: "BVAPPEND",
      aid: 1,
      title: "Append",
      ownerMid: 123,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: appendVideo.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nappend",
      published: false,
      isDeleted: false,
    });

    const rebuildVideo = upsertVideo(db, {
      bvid: "BVREBUILD",
      aid: 2,
      title: "Rebuild",
      ownerMid: 456,
      pageCount: 1,
    });
    db.prepare("UPDATE videos SET publish_needs_rebuild = 1 WHERE id = ?").run(rebuildVideo.id);

    assert.deepEqual(listVideosPendingPublish(db).map((item) => item.bvid), ["BVAPPEND", "BVREBUILD"]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runPendingVideoPublishSweep publishes queued videos serially and stops after the first failure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-publish-sweep-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const publishedBvids: string[] = [];

  try {
    const appendVideo = upsertVideo(db, {
      bvid: "BVAPPENDSWEEP",
      aid: 1,
      title: "Append Sweep",
      ownerMid: 123,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: appendVideo.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nappend",
      published: false,
      isDeleted: false,
    });

    const rebuildVideo = upsertVideo(db, {
      bvid: "BVREBUILDSWEEP",
      aid: 2,
      title: "Rebuild Sweep",
      ownerMid: 456,
      pageCount: 1,
    });
    db.prepare("UPDATE videos SET publish_needs_rebuild = 1 WHERE id = ?").run(rebuildVideo.id);

    const result = await runPendingVideoPublishSweep({
      summaryUsers: "123,456",
      authFile: ".auth/bili-auth.json",
      dbPath,
      workRoot: "work",
      collectRecentUploadsImpl: async () => ({
        summaryUsers: [],
        uploads: [],
      }),
      findAuthFileForUserImpl(_authFile, userIndex) {
        return path.join(tempRoot, `.auth-${userIndex}.json`);
      },
      runPipelineForBvidImpl: async (options) => {
        publishedBvids.push(String(options.bvid));
        if (options.bvid === "BVREBUILDSWEEP") {
          throw new Error("rate limited");
        }

        return {
          ok: true,
          pendingPublishPages: listPendingPublishParts(db, appendVideo.id).map((part) => part.page_no),
        };
      },
      computePublishCooldownMsImpl: () => 0,
      sleepImpl: async () => {},
    });

    assert.deepEqual(result.tasks.map((item) => `${item.video.bvid}:${item.publishMode}`), [
      "BVAPPENDSWEEP:append",
      "BVREBUILDSWEEP:rebuild",
    ]);
    assert.deepEqual(publishedBvids, ["BVAPPENDSWEEP", "BVREBUILDSWEEP"]);
    assert.equal(result.aborted, true);
    assert.deepEqual(result.failures, [
      {
        bvid: "BVREBUILDSWEEP",
        title: "Rebuild Sweep",
        message: "rate limited",
        publishMode: "rebuild",
      },
    ]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runPendingVideoPublishSweep healthchecks recently uploaded published videos even without pending parts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-publish-healthcheck-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const publishedBvids: string[] = [];

  try {
    const publishedVideo = upsertVideo(db, {
      bvid: "BVHEALTHCHECK",
      aid: 1,
      title: "Healthcheck",
      ownerMid: 123,
      pageCount: 1,
      rootCommentRpid: 300001,
      topCommentRpid: 300001,
    });
    upsertVideoPart(db, {
      videoId: publishedVideo.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\npublished",
      published: true,
      publishedCommentRpid: 300001,
      isDeleted: false,
    });

    const result = await runPendingVideoPublishSweep({
      summaryUsers: "123",
      authFile: ".auth/bili-auth.json",
      dbPath,
      workRoot: "work",
      collectRecentUploadsImpl: async () => ({
        summaryUsers: [{ mid: 123, source: "123" }],
        uploads: [
          {
            mid: 123,
            bvid: "BVHEALTHCHECK",
            aid: 1,
            title: "Healthcheck",
            authFile: path.join(tempRoot, ".auth-1.json"),
            createdAtUnix: 100,
            createdAt: new Date(100 * 1000).toISOString(),
            source: "123",
          },
        ],
      }),
      findAuthFileForUserImpl(_authFile, userIndex) {
        return path.join(tempRoot, `.auth-${userIndex}.json`);
      },
      runPipelineForBvidImpl: async (options) => {
        publishedBvids.push(String(options.bvid));
        return { ok: true };
      },
      computePublishCooldownMsImpl: () => 0,
      sleepImpl: async () => {},
    });

    assert.deepEqual(result.tasks.map((item) => `${item.video.bvid}:${item.publishMode}`), [
      "BVHEALTHCHECK:append",
    ]);
    assert.deepEqual(publishedBvids, ["BVHEALTHCHECK"]);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.failures, []);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runPendingVideoPublishSweep only cools down after tasks that actually created comments", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-publish-cooldown-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const sleepCalls: number[] = [];

  try {
    const firstVideo = upsertVideo(db, {
      bvid: "BVNOCOOLDOWN",
      aid: 1,
      title: "No Cooldown",
      ownerMid: 123,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: firstVideo.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nfirst",
      published: false,
      isDeleted: false,
    });

    const secondVideo = upsertVideo(db, {
      bvid: "BVWITHCOOLDOWN",
      aid: 2,
      title: "With Cooldown",
      ownerMid: 123,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: secondVideo.id,
      pageNo: 1,
      cid: 102,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nsecond",
      published: false,
      isDeleted: false,
    });

    const thirdVideo = upsertVideo(db, {
      bvid: "BVAFTERCOOLDOWN",
      aid: 3,
      title: "After Cooldown",
      ownerMid: 123,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: thirdVideo.id,
      pageNo: 1,
      cid: 103,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nthird",
      published: false,
      isDeleted: false,
    });

    const result = await runPendingVideoPublishSweep({
      summaryUsers: "123",
      authFile: ".auth/bili-auth.json",
      dbPath,
      workRoot: "work",
      collectRecentUploadsImpl: async () => ({
        summaryUsers: [],
        uploads: [],
      }),
      findAuthFileForUserImpl() {
        return path.join(tempRoot, ".auth-1.json");
      },
      runPipelineForBvidImpl: async (options) => {
        if (options.bvid === "BVNOCOOLDOWN") {
          return {
            ok: true,
            publishResult: {
              action: "skip-publish",
              createdComments: [],
            },
          };
        }

        return {
          ok: true,
          publishResult: {
            action: "append-replies",
            createdComments: [{ rpid: options.bvid === "BVWITHCOOLDOWN" ? 1 : 2 }],
          },
        };
      },
      computePublishCooldownMsImpl: () => 1234,
      sleepImpl: async (timeoutMs) => {
        sleepCalls.push(timeoutMs);
      },
    });

    assert.deepEqual(result.tasks.map((item) => item.video.bvid), [
      "BVNOCOOLDOWN",
      "BVWITHCOOLDOWN",
      "BVAFTERCOOLDOWN",
    ]);
    assert.deepEqual(sleepCalls, [1234, 1234]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runPendingVideoPublishSweep runs at most two publish tasks concurrently", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-publish-concurrency-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const started: string[] = [];
  const finished: string[] = [];
  const running = new Set<string>();
  const waiters = new Map<string, () => void>();

  try {
    for (const [index, bvid] of ["BVCONC1", "BVCONC2", "BVCONC3", "BVCONC4"].entries()) {
      const video = upsertVideo(db, {
        bvid,
        aid: index + 1,
        title: bvid,
        ownerMid: 123,
        pageCount: 1,
      });
      upsertVideoPart(db, {
        videoId: video.id,
        pageNo: 1,
        cid: 100 + index,
        partTitle: "P1",
        durationSec: 10,
        summaryText: `<1P>\n${bvid}`,
        published: false,
        isDeleted: false,
      });
    }

    const sweepPromise = runPendingVideoPublishSweep({
      summaryUsers: "123",
      authFile: ".auth/bili-auth.json",
      dbPath,
      workRoot: "work",
      collectRecentUploadsImpl: async () => ({
        summaryUsers: [],
        uploads: [],
      }),
      findAuthFileForUserImpl() {
        return path.join(tempRoot, ".auth-1.json");
      },
      runPipelineForBvidImpl: async (options) => {
        const bvid = String(options.bvid);
        started.push(bvid);
        running.add(bvid);
        await new Promise<void>((resolve) => {
          waiters.set(bvid, resolve);
        });
        running.delete(bvid);
        finished.push(bvid);
        return {
          ok: true,
          publishResult: {
            action: "append-replies",
            createdComments: [{ rpid: started.length }],
          },
        };
      },
      computePublishCooldownMsImpl: () => 0,
      sleepImpl: async () => {},
    });

    while (started.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(started, ["BVCONC1", "BVCONC2"]);
    assert.equal(running.size, 2);

    waiters.get("BVCONC1")?.();
    while (started.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(started, ["BVCONC1", "BVCONC2", "BVCONC3"]);
    assert.equal(running.size, 2);

    waiters.get("BVCONC2")?.();
    while (started.length < 4) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(started, ["BVCONC1", "BVCONC2", "BVCONC3", "BVCONC4"]);
    assert.equal(running.size, 2);

    for (const bvid of ["BVCONC3", "BVCONC4"]) {
      waiters.get(bvid)?.();
    }

    const result = await sweepPromise;
    assert.equal(result.aborted, false);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(finished.sort(), ["BVCONC1", "BVCONC2", "BVCONC3", "BVCONC4"]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler-tasks barrel re-exports split modules", () => {
  assert.equal(schedulerTasks.parseSummaryUsers, parseSummaryUsers);
  assert.equal(schedulerTasks.runPipelinesWithConcurrency, runPipelinesWithConcurrency);
  assert.equal(schedulerTasks.cleanupOldWorkDirectories, cleanupOldWorkDirectories);
  assert.equal(schedulerTasks.runRecentVideoGapCheck, runRecentVideoGapCheck);
  assert.equal(schedulerTasks.runPendingVideoPublishSweep, runPendingVideoPublishSweep);
});
