import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { uploadTextToPaste } from "../src/domains/bili/paste-upload";
import { extractErrorDetails } from "../src/shared/cli/errors";
import { isSummaryPasteUrl } from "../src/domains/summary/paste-links";
import { splitSummaryForComments } from "../src/domains/summary/format";

process.env.PRIVATEBIN_URL = "https://privatebin.tool.voxwing.top";
const id = "1234567890abcdef";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeKey(value: string) {
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char));
  return Buffer.from(number.toString(16).padStart(64, "0"), "hex");
}

test("PrivateBin encrypts UTF8 with authenticated v2 metadata and keeps the key out of requests", async () => {
  const text = "<2P>\n2#01:08 中文总结 & VR\n第二行";
  let payload;
  const url = await uploadTextToPaste(text, (async (endpoint, options) => {
    assert.equal(endpoint, "https://privatebin.tool.voxwing.top/");
    assert.equal(options?.headers["X-Requested-With"], "JSONHttpRequest");
    assert.equal(options?.redirect, "manual");
    assert.ok(options?.signal);
    assert.ok(!String(options?.body).includes(text));
    payload = JSON.parse(String(options?.body));
    return Response.json({ status: 0, id, url: "https://foreign.example/", deletetoken: "private-delete-token" });
  }) as typeof fetch);
  assert.match(url, /^https:\/\/privatebin\.tool\.voxwing\.top\/\?1234567890abcdef#[1-9A-HJ-NP-Za-km-z]+&view=reader$/u);
  assert.equal(payload.v, 2);
  assert.deepEqual(payload.meta, { expire: "never" });
  const [spec, formatter, discussion, burn] = payload.adata;
  assert.deepEqual([formatter, discussion, burn], ["plaintext", 0, 0]);
  assert.deepEqual(spec.slice(2), [100000, 256, 128, "aes", "gcm", "none"]);
  const key = pbkdf2Sync(decodeKey(new URL(url).hash.slice(1).split("&")[0]), Buffer.from(spec[1], "base64"), 100000, 32, "sha256");
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(spec[0], "base64"));
  cipher.setAAD(Buffer.from(JSON.stringify(payload.adata)));
  const ct = Buffer.from(payload.ct, "base64");
  cipher.setAuthTag(ct.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([cipher.update(ct.subarray(0, -16)), cipher.final()]).toString("utf8")), { paste: text });
  const tampered = createDecipheriv("aes-256-gcm", key, Buffer.from(spec[0], "base64"));
  tampered.setAAD(Buffer.from(JSON.stringify([spec, formatter, discussion, 1])));
  tampered.setAuthTag(ct.subarray(-16));
  tampered.update(ct.subarray(0, -16));
  assert.throws(() => tampered.final());
});

test("PrivateBin generates independent keys for repeated text", async () => {
  const mock = (async () => Response.json({ status: 0, id })) as typeof fetch;
  assert.notEqual(await uploadTextToPaste("same", mock), await uploadTextToPaste("same", mock));
});

test("PrivateBin errors retain bounded diagnostics without repeating uploads", async () => {
  let calls = 0;
  await assert.rejects(uploadTextToPaste("text", (async () => {
    calls++;
    return new Response("failure " + "x".repeat(3000), { status: 429 });
  }) as typeof fetch), (error) => {
    const details = extractErrorDetails(error);
    assert.equal(details.status, 429);
    assert.equal(String(details.responseBody).length, 2000);
    return true;
  });
  assert.equal(calls, 1);
  for (const response of [new Response("login"), Response.json({ status: 1, message: "rate limited" }), Response.json({ status: 0, id: "../foreign" }), Response.json(null)]) {
    await assert.rejects(uploadTextToPaste("text", (async () => response) as typeof fetch));
  }
});

test("PrivateBin validates configuration before sending data", async () => {
  const previous = process.env.PRIVATEBIN_URL;
  try {
    for (const value of ["", "http://insecure.example", "https://user:pass@example.com", "https://example.com/subpath"]) {
      process.env.PRIVATEBIN_URL = value;
      await assert.rejects(uploadTextToPaste("text", (async () => assert.fail("must not upload")) as typeof fetch));
    }
  } finally { process.env.PRIVATEBIN_URL = previous; }
});

test("PrivateBin and legacy links preserve page coverage and the complete decryption fragment", () => {
  const privateUrl = `https://privatebin.tool.voxwing.top/?${id}#${"A".repeat(44)}`;
  for (const url of [privateUrl, `${privateUrl}&view=reader`, `${privateUrl}&view=original`, `${privateUrl.replace("#", "#-")}&view=reader`, privateUrl.replace("#", "#-"), "https://paste.rs/Example"]) {
    assert.ok(isSummaryPasteUrl(url));
    const chunks = splitSummaryForComments(`<2P>\n${url}\n\n<3P>\n${url}`, 700);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].pages, [2, 3]);
    assert.ok(chunks[0].message.includes(url));
  }
  for (const url of [privateUrl.split("#")[0], privateUrl.replace("privatebin.tool.voxwing.top", "foreign.example"), privateUrl.replace(id, "incorrect"), `${privateUrl}&view=unknown`, `${privateUrl}&view=reader&extra=1`]) assert.equal(isSummaryPasteUrl(url), false);
});
