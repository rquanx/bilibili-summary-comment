import test from "node:test";
import assert from "node:assert/strict";
import { shortenSummaryUrl } from "../src/domains/bili/short-link";

const target = "https://privatebin.tool.voxwing.top/?1234567890abcdef#" + "A".repeat(44) + "&view=reader";
process.env.SHORT_LINK_PROVIDER = "chhoto";
process.env.KUTT_URL = "https://s.voxwing.top/";
process.env.KUTT_API_KEY = "local-test-key";

test("Chhoto creates and verifies the complete encrypted reader URL without following redirects", async () => {
  let address = "";
  const calls: string[] = [];
  const fetchImpl = (async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers["X-API-Key"], "local-test-key");
    assert.equal(options.redirect, "manual");
    if (calls.length === 1) {
      assert.equal(options.method, "POST");
      const body = JSON.parse(String(options.body));
      assert.equal(body.longlink, target);
      assert.equal(body.expiry_delay, 0);
      assert.match(body.shortlink, /^[a-f0-9]{10}$/u);
      address = body.shortlink;
      return Response.json({ success: true, error: false, shorturl: "https://s.voxwing.top/" + address, expiry_time: 0 });
    }
    assert.equal(options.method, "QUERY");
    assert.equal(options.body, address);
    return Response.json({ success: true, error: false, longurl: target, enabled: true, expiry_time: 0 });
  }) as typeof fetch;
  assert.equal(await shortenSummaryUrl(target, fetchImpl), "https://s.voxwing.top/" + address);
  assert.deepEqual(calls, ["https://s.voxwing.top/api/new", "https://s.voxwing.top/api/expand"]);
});

test("Chhoto reuses only an identical active mapping after a collision", async () => {
  for (const changes of [{}, { longurl: "https://different.example/" }, { enabled: false }, { expiry_time: 123 }]) {
    let calls = 0;
    const result = await shortenSummaryUrl(target, (async () => {
      calls++;
      return calls === 1
        ? Response.json({ success: false, error: true, reason: "Short URL is already in use!" }, { status: 400 })
        : Response.json({ success: true, error: false, longurl: target, enabled: true, expiry_time: 0, ...changes });
    }) as typeof fetch);
    assert.equal(calls, 2);
    assert.equal(result === target, Object.keys(changes).length !== 0);
  }
});

test("Chhoto errors and ambiguous timeouts do not retry writes", async () => {
  for (const response of [new Response("unavailable", { status: 503 }), Response.json(null),
    Response.json({ success: true, error: false, shorturl: "unexpected" }), Response.json({})]) {
    let calls = 0;
    assert.equal(await shortenSummaryUrl(target, (async () => { calls++; return response; }) as typeof fetch), target);
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.equal(await shortenSummaryUrl(target, (async () => { calls++; throw new Error("ambiguous timeout"); }) as typeof fetch), target);
  assert.equal(calls, 1);
});

test("Chhoto failed readback retains the original URL", async () => {
  for (const response of [new Response("unavailable", { status: 503 }), Response.json(null),
    Response.json({ success: false, error: true }), Response.json({ success: true, error: false, longurl: target })]) {
    let calls = 0;
    assert.equal(await shortenSummaryUrl(target, (async (_url, options) => {
      calls++;
      return calls === 1 ? Response.json({ success: true, error: false, shorturl: "https://s.voxwing.top/" + JSON.parse(String(options.body)).shortlink }) : response;
    }) as typeof fetch), target);
    assert.equal(calls, 2);
  }
});
