import test from "node:test";
import assert from "node:assert/strict";
import { CliError, createCliError, errorToJson } from "../src/shared/cli/errors";

test("createCliError returns a typed error with normalized details", () => {
  const error = createCliError("Bad input", {
    received: "oops",
    ignored: undefined,
  });

  assert.ok(error instanceof CliError);
  assert.deepEqual(error.details, {
    received: "oops",
  });
});

test("errorToJson includes CliError details in the payload", () => {
  const payload = errorToJson(createCliError("Bad input", { field: "--type" }));

  assert.equal(payload.ok, false);
  assert.equal(payload.message, "Bad input");
  assert.equal(payload.field, "--type");
  assert.match(payload.stack, /CliError: Bad input/);
});

test("errorToJson derives a videoUrl from video context details", () => {
  const payload = errorToJson(createCliError("Publish failed", {
    bvid: "BV1VideoUrl",
    pageNo: 3,
  }));

  assert.equal(payload.videoUrl, "https://www.bilibili.com/video/BV1VideoUrl?p=3");
});

test("errorToJson includes transport details from rich API errors", () => {
  const payload = errorToJson(Object.assign(new Error("啥都木有"), {
    code: -404,
    statusCode: 200,
    path: "https://api.bilibili.com/x/v2/reply/top",
    method: "post",
    rawResponse: {
      data: {
        code: -404,
        message: "啥都木有",
      },
    },
  }));

  assert.equal(payload.message, "啥都木有");
  assert.equal(payload.code, -404);
  assert.equal(payload.statusCode, 200);
  assert.equal(payload.path, "https://api.bilibili.com/x/v2/reply/top");
  assert.equal(payload.method, "post");
  assert.deepEqual(payload.responseData, {
    code: -404,
    message: "啥都木有",
  });
});

test("errorToJson includes nested cause and summary request context details", () => {
  const transportCause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7897"), {
    code: "ECONNREFUSED",
    errno: -4078,
    syscall: "connect",
    address: "127.0.0.1",
    port: 7897,
  });
  const error = Object.assign(
    new Error("Summary request transport failed: connect ECONNREFUSED 127.0.0.1:7897 | endpoint=https://example.com/v1/responses | model=kimi-k2.5 | format=responses", {
      cause: Object.assign(new Error("fetch failed"), {
        cause: transportCause,
      }),
    }),
    {
      summaryEndpoint: "https://example.com/v1/responses",
      summaryModel: "kimi-k2.5",
      summaryApiFormat: "responses",
    },
  );

  const payload = errorToJson(error);

  assert.equal(payload.summaryEndpoint, "https://example.com/v1/responses");
  assert.equal(payload.summaryModel, "kimi-k2.5");
  assert.equal(payload.summaryApiFormat, "responses");
  assert.equal(payload.causeMessage, "connect ECONNREFUSED 127.0.0.1:7897");
  assert.equal(payload.causeCode, "ECONNREFUSED");
  assert.equal(payload.causeErrno, -4078);
  assert.equal(payload.causeSyscall, "connect");
  assert.equal(payload.causeAddress, "127.0.0.1");
  assert.equal(payload.causePort, 7897);
});
