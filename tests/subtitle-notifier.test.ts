import test from "node:test";
import assert from "node:assert/strict";
import { sendServerChanNotification } from "../src/domains/subtitle/notifier";

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
