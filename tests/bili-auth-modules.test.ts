import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBiliLoginOutputFiles, saveBiliAuthBundle } from "../scripts/lib/bili/auth";

test("resolveBiliLoginOutputFiles auto-increments auth file names and does not auto-create cookie outputs", () => {
  const result = resolveBiliLoginOutputFiles({
    repoRoot: "D:\\repo",
    existsSync(targetPath) {
      return targetPath === "D:\\repo\\bili-auth.json";
    },
    readdirSync() {
      return [];
    },
  });

  assert.deepEqual(result, {
    authFile: "D:\\repo\\bili-auth_2.json",
    cookieFile: null,
    slot: 2,
  });
});

test("saveBiliAuthBundle writes only the auth json when cookie output is omitted", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-auth-only-"));
  const authFile = path.join(tempRoot, "bili-auth.json");

  try {
    const result = saveBiliAuthBundle({
      rawData: {
        token_info: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          mid: 123,
        },
        cookie_info: {
          cookies: [
            {
              name: "SESSDATA",
              value: "cookie-value",
            },
          ],
        },
      },
      source: "test",
      authFile,
      cookieFile: null,
    });

    assert.equal(fs.existsSync(authFile), true);
    assert.equal(fs.existsSync(path.join(tempRoot, "cookie.txt")), false);
    assert.equal(result.cookieFile, null);
    assert.match(fs.readFileSync(authFile, "utf8"), /"accessToken": "access-token"/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
