import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPinnedSummaryComment,
  readHistoricalSummaryCursor,
  runHistoricalSummaryBackfill,
} from "../src/domains/scheduler/historical-summary";

test("isPinnedSummaryComment requires generated-summary evidence", () => {
  assert.equal(isPinnedSummaryComment("<1P>\n1#00:00 summary"), true);
  assert.equal(isPinnedSummaryComment("1P\n1#00:00 legacy summary"), true);
  assert.equal(isPinnedSummaryComment("<1P>\nhttps://paste.rs/example"), true);
  assert.equal(isPinnedSummaryComment("<1P>\n1#00:00 first summary\n<2P>\n2#00:00 second summary"), true);
  assert.equal(isPinnedSummaryComment("<1P> first note\n<2P> second note"), false);
  assert.equal(isPinnedSummaryComment("<1P>\nhttps://example.com/corrected-video"), false);
  assert.equal(isPinnedSummaryComment("1P summary"), false);
  assert.equal(isPinnedSummaryComment("<1P> 视频异常说明，请以重新上传的版本为准"), false);
  assert.equal(isPinnedSummaryComment("ordinary pinned announcement"), false);
  assert.equal(isPinnedSummaryComment(""), false);
});

test("historical backfill recovers an abandoned lock from another container", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-summary-foreign-lock-"));
  const cursorPath = path.join(tempRoot, "cursor.json");
  const lockPath = `${cursorPath}.lock`;
  const staleTime = Date.now() - (2 * 60_000);

  try {
    fs.mkdirSync(lockPath, { recursive: true });
    const ownerPath = path.join(lockPath, "owner.json");
    fs.writeFileSync(ownerPath, JSON.stringify({
      pid: process.pid,
      hostname: "old-container",
      cursorPath,
      updatedAt: new Date(staleTime).toISOString(),
    }), "utf8");
    fs.utimesSync(ownerPath, staleTime / 1000, staleTime / 1000);

    const result = await runHistoricalSummaryBackfill({
      summaryUsers: "",
      cursorPath,
      repoRoot: tempRoot,
    });

    assert.deepEqual(result.runs, []);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("historical backfill checks the live webpage comment API before processing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-summary-live-check-"));
  const cursorPath = path.join(tempRoot, "cursor.json");
  const pipelineBvids: string[] = [];
  const preservedTopCommentRpids: Array<number | null | undefined> = [];
  const inspectedAids: number[] = [];

  try {
    const result = await runHistoricalSummaryBackfill({
      summaryUsers: "123",
      authFile: ".auth/bili-auth.json",
      cursorPath,
      repoRoot: tempRoot,
      now: new Date("2026-07-29T04:00:00.000Z"),
      dailyLimit: 2,
      maxPipelineStartsPerRun: 2,
      requestDelayMs: 0,
      findAuthFileForUserImpl() {
        return path.join(tempRoot, ".auth", "bili-auth.json");
      },
      readCookieStringFromAuthFileImpl() {
        return "SESSDATA=fake";
      },
      createClientImpl: (() => ({
        user: {
          async getVideos({ pn }) {
            if (pn > 1) {
              return {
                list: {
                  vlist: [],
                },
              };
            }

            return {
              list: {
                vlist: [
                  {
                    aid: 101,
                    bvid: "BVPINNED",
                    title: "Already summarized",
                    created: Date.parse("2026-07-29T02:00:00+08:00") / 1000,
                  },
                  {
                    aid: 102,
                    bvid: "BVNEEDS",
                    title: "Needs summary",
                    created: Date.parse("2026-07-29T01:00:00+08:00") / 1000,
                  },
                  {
                    aid: 103,
                    bvid: "BVOLDER",
                    title: "Older",
                    created: Date.parse("2026-07-28T23:00:00+08:00") / 1000,
                  },
                ],
              },
            };
          },
        },
      })) as any,
      async getGuestTopCommentImpl({ oid }) {
        inspectedAids.push(oid);
        if (oid === 101) {
          return {
            oid,
            type: 1,
            hasTopComment: true,
            topComment: {
              rpid: 9001,
              message: "<1P>\n1#00:00 existing summary",
            },
            raw: {},
          } as any;
        }

        return {
          oid,
          type: 1,
          hasTopComment: true,
          topComment: {
            rpid: 9002,
            message: "<1P> 视频异常说明，请以重新上传的版本为准",
          },
          raw: {},
        } as any;
      },
      async runPipelineForBvidImpl(options) {
        pipelineBvids.push(options.bvid);
        preservedTopCommentRpids.push(options.preservedTopCommentRpid);
        return {
          ok: true,
          generatedPages: [1],
        };
      },
    });

    assert.deepEqual(inspectedAids, [101, 102]);
    assert.deepEqual(pipelineBvids, ["BVNEEDS"]);
    assert.deepEqual(preservedTopCommentRpids, [9002]);
    assert.deepEqual(result.skippedPinnedSummary.map((item) => item.bvid), ["BVPINNED"]);
    assert.equal(result.quotaUsed, 1);
    assert.equal(result.advanced, true);
    assert.equal(result.targetDate, "2026-07-28");

    const cursor = readHistoricalSummaryCursor(cursorPath, "2099-01-01");
    assert.equal(cursor.targetDate, "2026-07-28");
    assert.equal(cursor.quotaDate, "2026-07-29");
    assert.equal(cursor.quotaUsed, 1);
    assert.equal(cursor.nextProcessAt, "2026-07-29T16:00:00.000Z");
    assert.deepEqual(cursor.completedBvids, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("historical backfill does not process when the live pinned-summary check fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-summary-check-failure-"));
  const cursorPath = path.join(tempRoot, "cursor.json");
  let pipelineRuns = 0;

  try {
    const result = await runHistoricalSummaryBackfill({
      summaryUsers: "123",
      cursorPath,
      repoRoot: tempRoot,
      now: new Date("2026-07-29T04:00:00.000Z"),
      requestDelayMs: 0,
      findAuthFileForUserImpl() {
        return path.join(tempRoot, ".auth", "bili-auth.json");
      },
      readCookieStringFromAuthFileImpl() {
        return "SESSDATA=fake";
      },
      createClientImpl: (() => ({
        user: {
          async getVideos() {
            return {
              list: {
                vlist: [
                  {
                    aid: 201,
                    bvid: "BVUNCERTAIN",
                    title: "Uncertain",
                    created: Date.parse("2026-07-29T01:00:00+08:00") / 1000,
                  },
                  {
                    aid: 202,
                    bvid: "BVOLDER",
                    title: "Older",
                    created: Date.parse("2026-07-28T23:00:00+08:00") / 1000,
                  },
                ],
              },
            };
          },
        },
      })) as any,
      async getGuestTopCommentImpl() {
        throw new Error("guest API unavailable");
      },
      async runPipelineForBvidImpl() {
        pipelineRuns += 1;
        return {
          ok: true,
        };
      },
    });

    assert.equal(pipelineRuns, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /Unable to confirm live pinned-summary state/u);
    assert.equal(result.quotaUsed, 0);
    assert.equal(result.advanced, false);
    assert.equal(result.targetDate, "2026-07-29");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("historical backfill does not consume quota when the pipeline fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-summary-pipeline-failure-"));
  const cursorPath = path.join(tempRoot, "cursor.json");

  try {
    const result = await runHistoricalSummaryBackfill({
      summaryUsers: "123",
      cursorPath,
      repoRoot: tempRoot,
      now: new Date("2026-07-29T04:00:00.000Z"),
      requestDelayMs: 0,
      findAuthFileForUserImpl() {
        return path.join(tempRoot, ".auth", "bili-auth.json");
      },
      readCookieStringFromAuthFileImpl() {
        return "SESSDATA=fake";
      },
      createClientImpl: (() => ({
        user: {
          async getVideos() {
            return {
              list: {
                vlist: [
                  {
                    aid: 203,
                    bvid: "BVFAILS",
                    title: "Pipeline fails",
                    created: Date.parse("2026-07-29T01:00:00+08:00") / 1000,
                  },
                  {
                    aid: 204,
                    bvid: "BVOLDER",
                    title: "Older",
                    created: Date.parse("2026-07-28T23:00:00+08:00") / 1000,
                  },
                ],
              },
            };
          },
        },
      })) as any,
      async getGuestTopCommentImpl() {
        return {
          hasTopComment: false,
          topComment: null,
          raw: {},
        } as any;
      },
      async runPipelineForBvidImpl() {
        throw new Error("simulated pipeline failure");
      },
    });

    assert.equal(result.failures.length, 1);
    assert.equal(result.quotaUsed, 0);

    const cursor = readHistoricalSummaryCursor(cursorPath, "2099-01-01");
    assert.equal(cursor.quotaUsed, 0);
    assert.equal(cursor.nextProcessAt, "2026-07-29T04:07:12.000Z");
    assert.deepEqual(cursor.completedBvids, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("historical backfill persists and enforces the total daily processing limit", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-summary-quota-"));
  const cursorPath = path.join(tempRoot, "cursor.json");
  const pipelineBvids: string[] = [];
  let uploadFetches = 0;

  const commonOptions = {
    summaryUsers: "123",
    cursorPath,
    repoRoot: tempRoot,
    now: new Date("2026-07-29T04:00:00.000Z"),
    dailyLimit: 1,
    requestDelayMs: 0,
    findAuthFileForUserImpl() {
      return path.join(tempRoot, ".auth", "bili-auth.json");
    },
    readCookieStringFromAuthFileImpl() {
      return "SESSDATA=fake";
    },
    createClientImpl: (() => ({
      user: {
        async getVideos() {
          uploadFetches += 1;
          return {
            list: {
              vlist: [
                {
                  aid: 301,
                  bvid: "BVFIRST",
                  title: "First",
                  created: Date.parse("2026-07-29T02:00:00+08:00") / 1000,
                },
                {
                  aid: 302,
                  bvid: "BVSECOND",
                  title: "Second",
                  created: Date.parse("2026-07-29T01:00:00+08:00") / 1000,
                },
                {
                  aid: 303,
                  bvid: "BVOLDER",
                  title: "Older",
                  created: Date.parse("2026-07-28T23:00:00+08:00") / 1000,
                },
              ],
            },
          };
        },
      },
    })) as any,
    async getGuestTopCommentImpl({ oid }) {
      return {
        oid,
        type: 1,
        hasTopComment: false,
        topComment: null,
        raw: {},
      } as any;
    },
    async runPipelineForBvidImpl(options) {
      pipelineBvids.push(options.bvid);
      return {
        ok: true,
      };
    },
  };

  try {
    const first = await runHistoricalSummaryBackfill(commonOptions);
    assert.deepEqual(pipelineBvids, ["BVFIRST"]);
    assert.equal(first.quotaUsed, 1);
    assert.equal(first.advanced, false);

    const fetchesAfterFirstRun = uploadFetches;
    const second = await runHistoricalSummaryBackfill(commonOptions);
    assert.deepEqual(pipelineBvids, ["BVFIRST"]);
    assert.equal(second.quotaUsed, 1);
    assert.equal(uploadFetches, fetchesAfterFirstRun);

    const cursor = readHistoricalSummaryCursor(cursorPath, "2099-01-01");
    assert.equal(cursor.targetDate, "2026-07-29");
    assert.equal(cursor.quotaUsed, 1);
    assert.deepEqual(cursor.completedBvids, ["BVFIRST"]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("historical backfill spaces pipeline starts across the full day", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "historical-summary-pacing-"));
  const cursorPath = path.join(tempRoot, "cursor.json");
  const pipelineBvids: string[] = [];
  let uploadFetches = 0;

  const buildOptions = (now: Date) => ({
    summaryUsers: "123",
    cursorPath,
    repoRoot: tempRoot,
    now,
    dailyLimit: 200,
    requestDelayMs: 0,
    findAuthFileForUserImpl() {
      return path.join(tempRoot, ".auth", "bili-auth.json");
    },
    readCookieStringFromAuthFileImpl() {
      return "SESSDATA=fake";
    },
    createClientImpl: (() => ({
      user: {
        async getVideos() {
          uploadFetches += 1;
          return {
            list: {
              vlist: [
                {
                  aid: 401,
                  bvid: "BVPACED1",
                  title: "Paced One",
                  created: Date.parse("2026-07-29T02:00:00+08:00") / 1000,
                },
                {
                  aid: 402,
                  bvid: "BVPACED2",
                  title: "Paced Two",
                  created: Date.parse("2026-07-29T01:00:00+08:00") / 1000,
                },
                {
                  aid: 403,
                  bvid: "BVOLDER",
                  title: "Older",
                  created: Date.parse("2026-07-28T23:00:00+08:00") / 1000,
                },
              ],
            },
          };
        },
      },
    })) as any,
    async getGuestTopCommentImpl({ oid }) {
      return {
        oid,
        type: 1,
        hasTopComment: false,
        topComment: null,
        raw: {},
      } as any;
    },
    async runPipelineForBvidImpl(options) {
      pipelineBvids.push(options.bvid);
      return {
        ok: true,
      };
    },
  });

  try {
    const first = await runHistoricalSummaryBackfill(
      buildOptions(new Date("2026-07-29T04:00:00.000Z")),
    );
    assert.deepEqual(pipelineBvids, ["BVPACED1"]);
    assert.equal(first.quotaUsed, 1);
    assert.equal(first.advanced, false);
    assert.equal(uploadFetches, 1);

    const beforeDue = await runHistoricalSummaryBackfill(
      buildOptions(new Date("2026-07-29T04:07:00.000Z")),
    );
    assert.deepEqual(pipelineBvids, ["BVPACED1"]);
    assert.equal(beforeDue.quotaUsed, 1);
    assert.equal(uploadFetches, 1);

    const afterDue = await runHistoricalSummaryBackfill(
      buildOptions(new Date("2026-07-29T04:08:00.000Z")),
    );
    assert.deepEqual(pipelineBvids, ["BVPACED1", "BVPACED2"]);
    assert.equal(afterDue.quotaUsed, 2);
    assert.equal(afterDue.advanced, true);
    assert.equal(uploadFetches, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
