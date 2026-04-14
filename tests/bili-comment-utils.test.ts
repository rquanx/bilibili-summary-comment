import test from "node:test";
import assert from "node:assert/strict";
import { getType, readCookie, resolveOid } from "../scripts/lib/bili/comment-utils";
import { CliError } from "../scripts/lib/cli/errors";

test("readCookie throws CliError when cookie inputs are missing", () => {
  assert.throws(
    () => readCookie({}, {
      existsSync() {
        return false;
      },
    }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.message, "Missing required option: --cookie, --cookie-file, or --auth-file");
      return true;
    },
  );
});

test("readCookie falls back to auth json before the default cookie file", () => {
  const cookie = readCookie({}, {
    existsSync(targetPath) {
      return String(targetPath).endsWith("\\.auth\\bili-auth.json");
    },
    readCookieStringFromAuthFileImpl(authFile) {
      return `auth:${authFile}`;
    },
    resolveBiliAuthFileImpl() {
      return "D:\\repo\\.auth\\bili-auth.json";
    },
  });

  assert.equal(cookie, "auth:D:\\repo\\.auth\\bili-auth.json");
});

test("readCookie still supports an explicit auth file override", () => {
  const cookie = readCookie(
    {
      "auth-file": "./secrets/bili-auth-2.json",
    },
    {
      readCookieStringFromAuthFileImpl(authFile) {
        return `auth:${authFile}`;
      },
      resolveBiliAuthFileImpl(authFile) {
        return `D:\\repo\\${String(authFile ?? "").replace(/\//g, "\\")}`;
      },
    },
  );

  assert.equal(cookie, "auth:D:\\repo\\.\\secrets\\bili-auth-2.json");
});

test("readCookie still honors an explicit cookie file before auth fallback", () => {
  const cookie = readCookie(
    {
      "cookie-file": "D:\\repo\\cookie.txt",
    },
    {
      readTextFileImpl(filePath) {
        return `cookie:${filePath}`;
      },
      readCookieStringFromAuthFileImpl() {
        return "auth:unused";
      },
    },
  );

  assert.equal(cookie, "cookie:D:\\repo\\cookie.txt");
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
