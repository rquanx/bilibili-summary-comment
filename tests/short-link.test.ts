import test from "node:test";
import assert from "node:assert/strict";
import { shortenSummaryUrl } from "../src/domains/bili/short-link";
import { uploadTextToPaste } from "../src/domains/bili/paste-upload";
import { isSummaryPasteUrl } from "../src/domains/summary/paste-links";
import { splitSummaryForComments } from "../src/domains/summary/format";

const target = "https://privatebin.tool.voxwing.top/?1234567890abcdef#" + "A".repeat(44) + "&view=reader";
process.env.PRIVATEBIN_URL = "https://privatebin.tool.voxwing.top/";
process.env.KUTT_URL = "https://s.voxwing.top/";
process.env.KUTT_API_KEY = "test-api-key";

test("Kutt preserves the full key and reader mode and reuses a stable address", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (url, options) => {
    assert.equal(url, "https://s.voxwing.top/api/v2/links");
    assert.equal(options.headers["X-API-Key"], "test-api-key");
    assert.equal(options.redirect, "manual");
    const body = JSON.parse(String(options.body)); bodies.push(body);
    assert.equal(body.target, target); assert.equal(body.reuse, true);
    return Response.json({ target, link: `https://s.voxwing.top/${body.customurl}` });
  }) as typeof fetch;
  const result = await shortenSummaryUrl(target, fetchImpl);
  assert.match(result, /^https:\/\/s\.voxwing\.top\/[a-f0-9]{10}$/u);
  assert.equal(await shortenSummaryUrl(target, fetchImpl), result);
  assert.deepEqual(bodies[0], bodies[1]);
});

test("PrivateBin uploads then shortens its new reader link", async () => {
  let calls = 0;
  const result = await uploadTextToPaste("中文摘要", (async (url, options) => {
    calls++;
    if (calls === 1) {
      assert.equal(url, process.env.PRIVATEBIN_URL);
      assert.equal(options.headers["X-API-Key"], undefined);
      return Response.json({ status: 0, id: "1234567890abcdef" });
    }
    const body = JSON.parse(String(options.body));
    assert.match(body.target, /#[1-9A-HJ-NP-Za-km-z]+&view=reader$/u);
    return Response.json({ target: body.target, link: "https://s.voxwing.top/abc123" });
  }) as typeof fetch);
  assert.equal(result, "https://s.voxwing.top/abc123"); assert.equal(calls, 2);
});

test("shortener failures retain the original URL without repeating POSTs", async () => {
  for (const response of [
    new Response("unavailable", { status: 503 }),
    Response.json({ target, link: "https://foreign.example/abc123" }),
    Response.json({ target: "wrong", link: "https://s.voxwing.top/abc123" }),
    Response.json({ target, link: "https://s.voxwing.top/abc123#key" }),
    Response.json(null),
  ]) {
    let calls = 0;
    assert.equal(await shortenSummaryUrl(target, (async () => { calls++; return response; }) as typeof fetch), target);
    assert.equal(calls, 1);
  }
  assert.equal(await shortenSummaryUrl(target, (async () => { throw new Error("timeout"); }) as typeof fetch), target);
});

test("short links and legacy PrivateBin URLs retain summary page coverage", () => {
  for (const url of ["https://s.voxwing.top/abc123", target]) {
    assert.ok(isSummaryPasteUrl(url));
    const chunks = splitSummaryForComments(`<2P>\n${url}\n\n<3P>\n${url}`, 700);
    assert.deepEqual(chunks[0].pages, [2, 3]); assert.ok(chunks[0].message.includes(url));
  }
  for (const url of ["https://s.voxwing.top/", "https://foreign.example/abc123", "https://s.voxwing.top/abc123?extra=1", "https://s.voxwing.top/abc123#key"]) assert.equal(isSummaryPasteUrl(url), false);
});
