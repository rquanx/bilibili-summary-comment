import test from "node:test";
import assert from "node:assert/strict";
import { getType, readCookie, resolveOid } from "../scripts/lib/bili/comment-utils.mjs";
import { CliError } from "../scripts/lib/cli/errors.mjs";

test("readCookie throws CliError when cookie inputs are missing", () => {
  assert.throws(
    () => readCookie({}),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.message, "Missing required option: --cookie or --cookie-file");
      return true;
    },
  );
});

test("getType preserves the invalid input in CliError details", () => {
  assert.throws(
    () => getType({ type: "0" }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.details.received, "0");
      return true;
    },
  );
});

test("resolveOid rejects invalid direct identifiers before touching the client", async () => {
  await assert.rejects(
    () => resolveOid({}, { aid: "abc" }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.message, "Invalid --oid/--aid, expected a positive integer");
      assert.equal(error.details.received, "abc");
      return true;
    },
  );
});
