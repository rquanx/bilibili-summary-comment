import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommentSubmissionStore } from "../src/domains/bili/comment-submission-store";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-submission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new CommentSubmissionStore(root) };
}

test("submitted hidden comments survive process restarts without a second POST", async (t) => {
  const { root, store } = fixture(t);
  const identity = { oid: 1, rootRpid: 2, message: "<2P> hidden content" };
  let calls = 0;
  const create = async () => { calls++; return { replyRes: { rpid: 123 }, warnings: [] }; };
  await store.submit(identity, create);
  // Visibility failure / paste upload failure happens after the server receipt.
  const resumed = await new CommentSubmissionStore(root).submit(identity, create);
  assert.equal(resumed.replyRes.rpid, 123);
  assert.equal(calls, 1);
  await store.submit({ ...identity, rootRpid: 3 }, create);
  assert.equal(calls, 2);
});

test("a timeout after acceptance blocks blind resubmission, including concurrent calls", async (t) => {
  const { root, store } = fixture(t);
  let calls = 0;
  let finish;
  const inFlight = store.submit("same", () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  await assert.rejects(new CommentSubmissionStore(root).submit("same", async () => { calls++; }), /outcome is unknown/);
  finish({ replyRes: { rpid: 42 } });
  await inFlight;
  assert.equal(calls, 1);
  await assert.rejects(store.submit("timeout", async () => { calls++; throw Error("connection reset after POST"); }));
  await assert.rejects(new CommentSubmissionStore(root).submit("timeout", async () => { calls++; }), /outcome is unknown/);
  assert.equal(calls, 2);
});

test("explicit server rejection can retry while a missing receipt stays reserved", async (t) => {
  const { store } = fixture(t);
  await assert.rejects(store.submit("rejected", async () => { throw Object.assign(Error("API rejected"), { rawResponse: { code: -400 } }); }));
  assert.equal((await store.submit("rejected", async () => ({ replyRes: { rpid: 77 } }))).replyRes.rpid, 77);
  await assert.rejects(store.submit("no receipt", async () => ({ replyRes: {} })), /no valid receipt/);
  await assert.rejects(store.submit("no receipt", async () => assert.fail("must not POST")), /outcome is unknown/);
});

test("fallback encryption link is reused when subsequent publication fails", async (t) => {
  const { root, store } = fixture(t);
  let uploads = 0;
  const resolve = async () => ({ processedMessage: `https://paste.example/?id#key${++uploads}`, badUnitIds: ["2|time|01:08"] });
  const first = await store.fallback("original", resolve);
  const again = await new CommentSubmissionStore(root).fallback("original", resolve);
  assert.deepEqual(again, first);
  assert.equal(uploads, 1);
});
