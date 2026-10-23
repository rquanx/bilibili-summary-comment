import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshSchedulerAuth } from "../src/domains/scheduler/auth-refresh";

const now = Date.parse("2026-10-24T00:00:00Z");

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-refresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (slot = "") => path.join(dir, `bili-auth${slot}.json`);
  const write = (slot = "", updatedAt = "2026-04-25T00:00:00Z") => {
    fs.writeFileSync(file(slot), JSON.stringify({ updatedAt }));
  };
  return { file, write };
}

test("refreshes due mapped accounts once and preserves the default cookie output", async (t) => {
  const { file, write } = fixture(t);
  write();
  write("_2");
  write("_3", "2026-10-23T00:00:00Z");
  write("_5"); // Unused credentials must not be refreshed.
  const calls: unknown[] = [];
  const result = await refreshSchedulerAuth({
    authFile: file(), summaryUsers: "1,2,3,4,1", refreshDays: 30, now,
    cookieFile: "legacy-cookie.txt",
    refreshImpl: async (options) => {
      calls.push(options);
      return { bundle: { updatedAt: new Date(now).toISOString() } } as never;
    },
  });
  assert.deepEqual(calls, [
    { authFile: file(), cookieFile: "legacy-cookie.txt" },
    { authFile: file("_2"), cookieFile: null },
  ]);
  assert.equal(result.refreshed, 2);
  assert.equal(result.failures, 0);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[2].reason, "not-due");
});

test("malformed auth and refresh rejection do not block later accounts", async (t) => {
  const { file, write } = fixture(t);
  fs.writeFileSync(file(), "invalid json");
  write("_2");
  write("_3");
  const calls: string[] = [];
  const result = await refreshSchedulerAuth({
    authFile: file(), summaryUsers: "1,2,3", refreshDays: 30, now,
    refreshImpl: async ({ authFile } = {}) => {
      calls.push(authFile!);
      if (authFile === file("_2")) throw new Error("账号未登录");
      return { bundle: { updatedAt: new Date(now).toISOString() } } as never;
    },
  });
  assert.deepEqual(calls, [file("_2"), file("_3")]);
  assert.equal(result.failures, 2);
  assert.equal(result.refreshed, 1);
});

test("indexed first-account fallback is deduplicated when the base is missing", async (t) => {
  const { file, write } = fixture(t);
  write("_1", "invalid timestamp");
  let calls = 0;
  const result = await refreshSchedulerAuth({
    authFile: file(), summaryUsers: "1,2,3", refreshDays: 30, now,
    refreshImpl: async () => {
      calls++;
      return { bundle: { updatedAt: new Date(now).toISOString() } } as never;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].reason, "auth-file-missing");
});

test("default account remains supported without users and force bypasses its age", async (t) => {
  const { file, write } = fixture(t);
  write("", "2026-10-23T00:00:00Z");
  let calls = 0;
  const result = await refreshSchedulerAuth({
    authFile: file(), summaryUsers: "", refreshDays: 30, force: true, now,
    refreshImpl: async () => {
      calls++;
      return { bundle: { updatedAt: new Date(now).toISOString() } } as never;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.refreshed, 1);
});
