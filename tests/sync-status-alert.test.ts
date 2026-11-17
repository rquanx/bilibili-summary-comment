import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportSyncStatus } from "../src/domains/scheduler/sync-status-alert";
import { sendServerChanNotification } from "../src/domains/subtitle/notifier";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-alert-"));
  const sent: Array<{ title: string }> = [];
  const options = {
    task: "viewpoint-sync" as const, logPath: "logs/viewpoint-sync/example.log",
    stateDirectory: root, enabled: true,
    send: async (message: { title: string }) => {
      sent.push(message);
      return { ok: true, skipped: false } as const;
    },
  };
  return { root, sent, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("full release pending is distinct from failure, never sends a false recovery, and deduplicates", async () => {
  const f = fixture();
  try {
    await reportSyncStatus({ ...f.options, status: "failed" });
    await reportSyncStatus({ ...f.options, status: "requires-release" });
    assert.match(f.sent[1].title, /等待完整发布/);
    assert.doesNotMatch(f.sent[1].title, /同步恢复/);
    await reportSyncStatus({ ...f.options, status: "requires-release" });
    assert.equal(f.sent.length, 2);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, "viewpoint-sync.json"), "utf8"));
    assert.equal(state.status, "requires-release");
    await reportSyncStatus({ ...f.options, status: "succeeded" });
    assert.match(f.sent[2].title, /同步恢复/);
  } finally { f.cleanup(); }
});

test("failure alerts deduplicate, remind after 24h, recover once, and reset for next incident", async () => {
  const f = fixture();
  try {
    const report = (status: "failed" | "succeeded", time: string) =>
      reportSyncStatus({ ...f.options, status, now: new Date(time) });
    await report("succeeded", "2026-11-14T00:00:00Z");
    assert.equal(f.sent.length, 0);
    await report("failed", "2026-11-14T01:00:00Z");
    await report("failed", "2026-11-14T07:00:00Z");
    assert.equal(f.sent.length, 1);
    await report("failed", "2026-11-15T01:00:00Z");
    assert.equal(f.sent.length, 2);
    await report("succeeded", "2026-11-15T02:00:00Z");
    assert.match(f.sent[2].title, /同步恢复/);
    await report("succeeded", "2026-11-15T03:00:00Z");
    assert.equal(f.sent.length, 3);
    await report("failed", "2026-11-15T04:00:00Z");
    assert.equal(f.sent.length, 4);
  } finally { f.cleanup(); }
});

test("failed delivery retries on next run and does not lose recovery notification", async () => {
  const f = fixture();
  try {
    const fail = async () => { throw new Error("offline"); };
    await assert.rejects(reportSyncStatus({ ...f.options, status: "failed", send: fail }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "viewpoint-sync.json"), "utf8")).notifiedAt, null);
    await reportSyncStatus({ ...f.options, status: "failed" });
    await assert.rejects(reportSyncStatus({ ...f.options, status: "succeeded", send: fail }));
    await reportSyncStatus({ ...f.options, status: "succeeded" });
    assert.equal(f.sent.length, 2);
  } finally { f.cleanup(); }
});

test("disabled/dry run never sends or changes state; missing key remains retryable", async () => {
  const f = fixture();
  try {
    await reportSyncStatus({ ...f.options, status: "failed", enabled: false });
    await reportSyncStatus({ ...f.options, status: "failed", dryRun: true });
    assert.deepEqual(fs.readdirSync(f.root), []);
    assert.equal(f.sent.length, 0);
    await reportSyncStatus({ ...f.options, status: "failed", send: async () => ({ ok: false, skipped: true, reason: "missing-send-key" }) });
    await reportSyncStatus({ ...f.options, status: "failed" });
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test("different sync jobs do not suppress each other's alerts", async () => {
  const f = fixture();
  try {
    await reportSyncStatus({ ...f.options, status: "failed" });
    await reportSyncStatus({ ...f.options, task: "subtitle-sync", status: "failed" });
    assert.equal(f.sent.length, 2);
  } finally { f.cleanup(); }
});

test("ServerChan delivery validates application result as well as HTTP status", async () => {
  const send = (body: unknown, status = 200) => sendServerChanNotification({
    title: "同步测试", sendKey: "test-only-key",
    fetchImpl: (async (_url, options) => {
      assert.ok(options?.signal);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  });
  assert.equal((await send({ code: 0 })).ok, true);
  assert.equal((await send({ errno: 0 })).ok, true);
  await assert.rejects(send({ code: 40001 }), /did not accept/);
  await assert.rejects(send({}), /did not accept/);
  await assert.rejects(send({ code: 0 }, 500), /500/);
});
