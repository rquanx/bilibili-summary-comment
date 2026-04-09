import test from "node:test";
import assert from "node:assert/strict";
import { CliError, createCliError, errorToJson } from "../scripts/lib/cli/errors.mjs";

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
