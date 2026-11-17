import test from "node:test";
import assert from "node:assert/strict";
import { uploadTextToPaste } from "../src/domains/bili/paste-upload";
import { isSummaryPasteUrl } from "../src/domains/summary/paste-links";
import { splitSummaryForComments } from "../src/domains/summary/format";

process.env.PRIVATEBIN_URL = "https://pastebin.tool.voxwing.top/";
process.env.PRIVATEBIN_LEGACY_URLS = "https://privatebin.tool.voxwing.top/";
delete process.env.KUTT_URL;
delete process.env.KUTT_API_KEY;
const id = "1234567890abcdef";
const suffix = `?${id}#${"A".repeat(44)}&view=reader`;

test("new uploads use the Pastebin domain and retain the encrypted reader fragment", async () => {
  let calls = 0;
  const link = await uploadTextToPaste("domain migration test", (async (endpoint, options) => {
    calls++;
    assert.equal(endpoint, "https://pastebin.tool.voxwing.top/");
    assert.equal(options.redirect, "manual");
    assert(!String(options.body).includes("domain migration test"));
    return Response.json({ status: 0, id });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.match(link, /^https:\/\/pastebin\.tool\.voxwing\.top\/\?[a-f0-9]{16}#[1-9A-HJ-NP-Za-km-z]+&view=reader$/u);
});

test("new and historical paste domains both retain summary coverage", () => {
  for (const origin of ["https://pastebin.tool.voxwing.top/", "https://privatebin.tool.voxwing.top/"]) {
    const link = origin + suffix;
    assert(isSummaryPasteUrl(link));
    const chunks = splitSummaryForComments(`<2P>\n${link}\n\n<3P>\n${link}`, 700);
    assert.deepEqual(chunks[0].pages, [2, 3]);
  }
  for (const link of ["https://foreign.example/" + suffix, "https://pastebin.tool.voxwing.top/", "https://pastebin.tool.voxwing.top/" + suffix + "&extra=1"]) {
    assert.equal(isSummaryPasteUrl(link), false);
  }
});
