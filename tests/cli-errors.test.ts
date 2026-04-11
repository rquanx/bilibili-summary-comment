import test from "node:test";
import assert from "node:assert/strict";
import { CliError, createCliError, errorToJson } from "../scripts/lib/cli/errors";

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
