import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createProgressReporter, formatBlockingErrorDetail } from "../src/domains/pipeline/progress";

test("createProgressReporter omits bvid from console prefix when full video url is present", () => {
  const outputStream = new PassThrough();
  let output = "";
  outputStream.on("data", (chunk) => {
    output += chunk.toString();
  });
  const reporter = createProgressReporter(
    {
      bvid: "BV173QABPE5u",
      aid: 123,
      title: "小泽又沐风2026.04.11 00.29.43 弹幕版",
    },
    1,
    {
      outputStream,
    },
  );

  reporter.log("xxxxx");

  assert.equal(output.split(/\r?\n/u).filter(Boolean).length, 1);
  assert.match(
    output,
    /\[小泽又沐风2026\.04\.11 00\.29\.43 弹幕版 \| https:\/\/www\.bilibili\.com\/video\/BV173QABPE5u\] xxxxx/u,
  );
  assert.doesNotMatch(output, /\[BV173QABPE5u \|/u);
});

test("formatBlockingErrorDetail flattens multiline errors into concise one-line console output", () => {
  const detail = formatBlockingErrorDetail(new Error([
    "Summary request failed: 500 Internal Server Error",
    "{\"type\":\"error\",\"message\":\"Cannot read properties of undefined (reading 'prompt_tokens')\"}",
  ].join("\n")));

  assert.equal(
    detail,
    "Summary request failed: 500 Internal Server Error {\"type\":\"error\",\"message\":\"Cannot read properties of undefined (reading 'prompt_tokens')\"}",
  );
});

test("formatBlockingErrorDetail truncates oversized console output", () => {
  const detail = formatBlockingErrorDetail(new Error("x".repeat(500)), 20);
  assert.equal(detail, `${"x".repeat(20)}...`);
});
