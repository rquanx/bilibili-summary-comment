import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryDownloadBiliSubtitle } from "../src/domains/subtitle/bili";

test("tryDownloadBiliSubtitle prefers subtitle_url over broken subtitle_url_v2", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-bili-"));
  const subtitlePath = path.join(tempDir, "subtitle.srt");
  const requests: string[] = [];

  globalThis.fetch = (async (url: string | URL) => {
    const resolvedUrl = String(url);
    requests.push(resolvedUrl);
    if (resolvedUrl.includes("subtitle.bilibili.com")) {
      throw new Error("fetch failed");
    }

    return {
      ok: true,
      json: async () => ({
        body: [
          {
            from: 0,
            to: 1.5,
            content: "测试字幕",
          },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const result = await tryDownloadBiliSubtitle({
      client: {
        video: {
          playerInfo: async () => ({
            subtitle: {
              subtitles: [
                {
                  lan: "ai-zh",
                  ai_status: 2,
                  subtitle_url: "//aisubtitle.hdslb.com/test.json",
                  subtitle_url_v2: "//subtitle.bilibili.com/bad.json",
                },
              ],
            },
          }),
        },
      },
      bvid: "BV1mWR7BwEja",
      cid: 38041489387,
      subtitlePath,
      cookie: null,
    });

    assert.deepEqual(requests, [
      "https://aisubtitle.hdslb.com/test.json",
    ]);
    assert.equal(result?.source, "bili_ai");
    assert.equal(result?.lang, "ai-zh");
    assert.match(fs.readFileSync(subtitlePath, "utf8"), /测试字幕/u);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("tryDownloadBiliSubtitle falls back to subtitle_url_v2 when subtitle_url is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-bili-"));
  const subtitlePath = path.join(tempDir, "subtitle.srt");
  const requests: string[] = [];

  globalThis.fetch = (async (url: string | URL) => {
    const resolvedUrl = String(url);
    requests.push(resolvedUrl);
    if (resolvedUrl.includes("aisubtitle.hdslb.com")) {
      throw new Error("fetch failed");
    }

    return {
      ok: true,
      json: async () => ({
        body: [
          {
            from: 3,
            to: 5,
            content: "备用字幕",
          },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const result = await tryDownloadBiliSubtitle({
      client: {
        video: {
          playerInfo: async () => ({
            subtitle: {
              subtitles: [
                {
                  lan: "zh-CN",
                  subtitle_url: "//aisubtitle.hdslb.com/unavailable.json",
                  subtitle_url_v2: "//subtitle.bilibili.com/fallback.json",
                },
              ],
            },
          }),
        },
      },
      bvid: "BV1mWR7BwEja",
      cid: 38041489387,
      subtitlePath,
      cookie: null,
    });

    assert.deepEqual(requests, [
      "https://aisubtitle.hdslb.com/unavailable.json",
      "https://subtitle.bilibili.com/fallback.json",
    ]);
    assert.equal(result?.source, "bili_subtitle");
    assert.equal(result?.lang, "zh-CN");
    assert.match(fs.readFileSync(subtitlePath, "utf8"), /备用字幕/u);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
