import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { resolveSummaryConfig } from "../scripts/lib/summary/config";
import {
  buildSummaryHttpRequest,
  buildSummaryPromptInput,
  extractSummaryText,
  resolveSummaryApiTarget,
} from "../scripts/lib/summary/client";
import { inspectSummaryPageMarkers, splitSummaryForComments } from "../scripts/lib/summary/format";
import { writeSummaryArtifacts } from "../scripts/lib/summary/files";
import { normalizeSummaryOutput } from "../scripts/lib/summary/output";
import { resolveSummaryPromptProfile } from "../scripts/lib/summary/prompt-config";
import { reindexSummaryTextToPage } from "../scripts/lib/db/summary-text";
import {
  requestSummaryWithFallback,
  shouldSkipSummaryPart,
  shouldRetrySummaryWithGlm5,
  summarizePartFromSubtitle,
} from "../scripts/lib/summary/service";
import { resolveVideoWorkDir } from "../scripts/lib/shared/work-paths";

test("resolveSummaryConfig normalizes args and env values", () => {
  const config = resolveSummaryConfig(
    {
      model: "gpt-test",
      "api-base-url": "https://example.com/v1/",
      "api-format": "OPENAI-CHAT",
      "prompt-config": "config/custom-prompts.json",
    },
    {
      SUMMARY_API_KEY: "key-123",
    },
  );

  assert.equal(config.model, "gpt-test");
  assert.equal(config.apiKey, "key-123");
  assert.equal(config.apiBaseUrl, "https://example.com/v1");
  assert.equal(config.apiFormat, "openai-chat");
  assert.equal(config.promptConfigPath, "config/custom-prompts.json");
});

test("resolveSummaryApiTarget infers responses endpoint in auto mode", () => {
  assert.deepEqual(
    resolveSummaryApiTarget("https://api.example.com/v1", "auto"),
    {
      apiFormat: "responses",
      endpointUrl: "https://api.example.com/v1/responses",
    },
  );
});

test("buildSummaryHttpRequest creates chat-completions payloads", () => {
  const request = buildSummaryHttpRequest({
    apiFormat: "openai-chat",
    model: "gpt-test",
    apiKey: "key-123",
    systemPrompt: "system",
    userPrompt: "user",
  });

  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, "Bearer key-123");
  assert.deepEqual(JSON.parse(request.body), {
    model: "gpt-test",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ],
  });
});

test("shouldRetrySummaryWithGlm5 only matches kimi prompt_tokens compatibility errors", () => {
  assert.equal(
    shouldRetrySummaryWithGlm5({
      model: "kimi-k2.5",
      error: new Error("Summary request failed: 500 Internal Server Error\n{\"message\":\"Cannot read properties of undefined (reading 'prompt_tokens')\"}"),
    }),
    true,
  );

  assert.equal(
    shouldRetrySummaryWithGlm5({
      model: "glm-5",
      error: new Error("Summary request failed: 500 Internal Server Error\n{\"message\":\"Cannot read properties of undefined (reading 'prompt_tokens')\"}"),
    }),
    false,
  );

  assert.equal(
    shouldRetrySummaryWithGlm5({
      model: "kimi-k2.5",
      error: new Error("Summary request failed: 500 Internal Server Error\n{\"message\":\"different error\"}"),
    }),
    false,
  );
});

test("shouldSkipSummaryPart only matches provider high-risk content filter errors", () => {
  assert.equal(
    shouldSkipSummaryPart({
      error: new Error("Summary request failed: 400 Bad Request\n{\"error\":{\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"message\\\":\\\"The request was rejected because it was considered high risk\\\",\\\"param\\\":\\\"prompt\\\",\\\"type\\\":\\\"content_filter\\\"}}\"}}}"),
    }),
    true,
  );

  assert.equal(
    shouldSkipSummaryPart({
      error: new Error("Summary request failed: 400 Bad Request\n{\"error\":{\"message\":\"content filter triggered for another reason\"}}"),
    }),
    false,
  );

  assert.equal(
    shouldSkipSummaryPart({
      error: new Error("Summary request failed: 429 Too Many Requests"),
    }),
    false,
  );
});

test("requestSummaryWithFallback retries once with glm-5 for known kimi prompt_tokens errors", async () => {
  const calls = [];
  const result = await requestSummaryWithFallback({
    requestArgs: {
      pageNo: 2,
      partTitle: "P2",
      durationSec: 120,
      subtitleText: "subtitle text",
      segments: [],
      promptProfile: null,
      model: "kimi-k2.5",
      apiKey: "key-123",
      apiBaseUrl: "https://example.com/v1",
      apiFormat: "openai-chat",
    },
    requestSummaryImpl: async (args) => {
      calls.push(args.model);
      if (args.model === "kimi-k2.5") {
        throw new Error("Summary request failed: 500 Internal Server Error\n{\"message\":\"Cannot read properties of undefined (reading 'prompt_tokens')\"}");
      }
      return "<2P> 2#00:00 fallback summary";
    },
  });

  assert.deepEqual(calls, ["kimi-k2.5", "glm-5"]);
  assert.equal(result.modelUsed, "glm-5");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, "kimi-prompt_tokens-error");
  assert.equal(result.summaryText, "<2P> 2#00:00 fallback summary");
});

test("requestSummaryWithFallback retries 429 responses once before surfacing the failure", async () => {
  const calls = [];

  await assert.rejects(
    requestSummaryWithFallback({
      requestArgs: {
        pageNo: 2,
        partTitle: "P2",
        durationSec: 120,
        subtitleText: "subtitle text",
        segments: [],
        promptProfile: null,
        model: "kimi-k2.5",
        apiKey: "key-123",
        apiBaseUrl: "https://example.com/v1",
        apiFormat: "openai-chat",
      },
      requestSummaryImpl: async (args) => {
        calls.push(args.model);
        throw new Error("Summary request failed: 429 Too Many Requests");
      },
    }),
    /429 Too Many Requests/u,
  );

  assert.deepEqual(calls, ["kimi-k2.5", "glm-5"]);
});

test("buildSummaryPromptInput uses raw subtitles when there are no parsed segments", () => {
  const promptInput = buildSummaryPromptInput({
    pageNo: 3,
    partTitle: "P3",
    durationSec: 60,
    subtitleText: "raw subtitle text",
    segments: [],
  });

  const userPrompt = JSON.parse(promptInput.userPrompt);
  assert.equal(userPrompt.page, 3);
  assert.equal(userPrompt.segments, null);
  assert.equal(userPrompt.rawSubtitleTextWhenSegmentParsingFailed, "raw subtitle text");
  assert.match(promptInput.systemPrompt, /3#时间 空格 总结/u);
  assert.match(promptInput.systemPrompt, /<3P> 3#00:00/u);
});

test("buildSummaryPromptInput tells the model not to mistake BGM for singing", () => {
  const promptInput = buildSummaryPromptInput({
    pageNo: 1,
    partTitle: "P1",
    durationSec: 120,
    subtitleText: "背景放着六月里的小雨",
    segments: [],
  });

  assert.match(promptInput.systemPrompt, /背景音乐/u);
  assert.match(promptInput.systemPrompt, /禁止写成主播在唱/u);
  assert.match(promptInput.systemPrompt, /不足以证明主播在唱/u);
});

test("buildSummaryPromptInput keeps the base prompt generic across stream types", () => {
  const promptInput = buildSummaryPromptInput({
    pageNo: 4,
    partTitle: "P4",
    durationSec: 300,
    subtitleText: "raw subtitle text",
    segments: [],
  });

  assert.match(promptInput.systemPrompt, /关键知识点/u);
  assert.match(promptInput.systemPrompt, /核心观点/u);
  assert.match(promptInput.systemPrompt, /默认不要把 summary 写得过短/u);
  assert.match(promptInput.systemPrompt, /把关键背景、动作、原因、结果或结论交代完整/u);
  assert.doesNotMatch(promptInput.systemPrompt, /优先保留观众最可能想回看的节目性内容/u);
});

test("resolveSummaryPromptProfile merges defaults, preset, and user overrides", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-prompt-config-"));
  const promptConfigPath = path.join(tempRoot, "summary-prompts.json");
  fs.writeFileSync(promptConfigPath, JSON.stringify({
    defaults: {
      extraRules: ["默认规则"],
    },
    presets: {
      knowledge: {
        displayName: "知识主播",
        extraRules: ["预设规则"],
      },
    },
    users: {
      "3690976520440286": {
        preset: "knowledge",
        extraRules: ["用户规则"],
      },
    },
  }, null, 2));

  try {
    const profile = resolveSummaryPromptProfile({
      ownerMid: 3690976520440286,
      promptConfigPath,
    });

    assert.equal(profile.displayName, "知识主播");
    assert.equal(profile.preset, "knowledge");
    assert.deepEqual(profile.extraRules, ["默认规则", "预设规则", "用户规则"]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildSummaryPromptInput appends per-user prompt rules", () => {
  const promptInput = buildSummaryPromptInput({
    pageNo: 2,
    partTitle: "P2",
    durationSec: 180,
    subtitleText: "raw subtitle text",
    segments: [],
    promptProfile: {
      displayName: "知识主播",
      extraRules: ["不要过度简略", "重点展开知识点"],
    },
  });

  assert.match(promptInput.systemPrompt, /知识主播/u);
  assert.match(promptInput.systemPrompt, /不要过度简略/u);
  assert.match(promptInput.systemPrompt, /重点展开知识点/u);
});

test("buildSummaryPromptInput can append deeper knowledge-interpretation rules", () => {
  const promptInput = buildSummaryPromptInput({
    pageNo: 6,
    partTitle: "P6",
    durationSec: 420,
    subtitleText: "raw subtitle text",
    segments: [],
    promptProfile: {
      displayName: "知识主播",
      extraRules: ["重点知识、关键论证和容易误解的部分，可以追加更多解释或解读。"],
    },
  });

  assert.match(promptInput.systemPrompt, /重点知识/u);
  assert.match(promptInput.systemPrompt, /更多解释或解读/u);
});

test("buildSummaryPromptInput can append entertainment-specific preset rules outside the base prompt", () => {
  const promptInput = buildSummaryPromptInput({
    pageNo: 5,
    partTitle: "P5",
    durationSec: 240,
    subtitleText: "raw subtitle text",
    segments: [],
    promptProfile: {
      displayName: "娱乐主播",
      extraRules: ["优先保留观众最可能想回看的节目性内容：连麦对象、表演、唱歌、PK。"],
    },
  });

  assert.match(promptInput.systemPrompt, /娱乐主播/u);
  assert.match(promptInput.systemPrompt, /节目性内容/u);
  assert.match(promptInput.systemPrompt, /连麦对象/u);
});

test("extractSummaryText reads responses output arrays", () => {
  const text = extractSummaryText({
    output: [
      {
        content: [
          { text: "<1P> line one" },
          { output_text: "line two" },
        ],
      },
    ],
  }, "responses");

  assert.equal(text, "<1P> line one\nline two");
});

test("normalizeSummaryOutput merges same-page blocks into one block", () => {
  const normalized = normalizeSummaryOutput("<1P>\n00:01 first\n\n<1P>\n00:20 second", 1);

  assert.equal(normalized, "<1P>\n1#00:01 first\n\n1#00:20 second");
});

test("normalizeSummaryOutput forces single-line summaries to use page-prefixed 00:00 markers", () => {
  const normalized = normalizeSummaryOutput("<3P> 00:00 主播撒娇质问哥哥不想跟我玩吗", 3);

  assert.equal(normalized, "<3P> 3#00:00 主播撒娇质问哥哥不想跟我玩吗");
});

test("normalizeSummaryOutput adds page-prefixed 00:00 markers to untimestamped single-line summaries", () => {
  const normalized = normalizeSummaryOutput("<3P> 主播撒娇质问哥哥不想跟我玩吗", 3);

  assert.equal(normalized, "<3P> 3#00:00 主播撒娇质问哥哥不想跟我玩吗");
});

test("normalizeSummaryOutput aligns timestamped lines to subtitle cue starts", () => {
  const subtitleText = [
    "1",
    "00:00:02,000 --> 00:00:04,000",
    "开场",
    "",
    "2",
    "00:00:08,600 --> 00:00:11,000",
    "开始连麦",
    "",
    "3",
    "00:00:16,100 --> 00:00:18,000",
    "开始唱歌",
    "",
  ].join("\n");

  const normalized = normalizeSummaryOutput("<1P>\n00:10 开始连麦\n00:18 开始唱歌", 1, {
    subtitleText,
  });

  assert.equal(normalized, "<1P>\n1#00:08 开始连麦\n1#00:16 开始唱歌");
});

test("normalizeSummaryOutput keeps page-prefixed timestamps and normalizes page number in multi-line output", () => {
  const normalized = normalizeSummaryOutput("<23P>\n99#03:03 继续聊天\n00:20 展示照片", 23);

  assert.equal(normalized, "<23P>\n23#03:03 继续聊天\n23#00:20 展示照片");
});

test("splitSummaryForComments splits oversized page blocks into multiple comment-safe chunks", () => {
  const repeatedLine = "这一段内容很长，需要继续拆分。";
  const longBody = Array.from({ length: 120 }, () => repeatedLine).join("");
  const chunks = splitSummaryForComments(`<1P> ${longBody}`, 1000);

  assert.ok(chunks.length > 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.pages),
    Array.from({ length: chunks.length }, () => [1]),
  );
  assert.ok(chunks.every((chunk) => chunk.message.length <= 1000));
  assert.ok(chunks.every((chunk) => chunk.message.startsWith("<1P>")));
});

test("inspectSummaryPageMarkers reports duplicate and invalid page markers", () => {
  const inspection = inspectSummaryPageMarkers(
    [
      "<1P> first",
      "",
      "<2P> second",
      "",
      "<2P> duplicate second",
      "",
      "<5P> invalid",
    ].join("\n"),
    [1, 2, 3, 4],
  );

  assert.deepEqual(inspection.pages, [1, 2, 5]);
  assert.deepEqual(inspection.duplicatePages, [2]);
  assert.deepEqual(inspection.invalidPages, [5]);
});

test("summarizePartFromSubtitle records fallback success metadata when glm-5 retry succeeds", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-service-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const subtitlePath = path.join(tempRoot, "p2.srt");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoWorkRoot = path.join(process.cwd(), workRoot);
  fs.writeFileSync(subtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:03,000",
    "测试字幕",
    "",
  ].join("\n"), "utf8");

  const events = [];
  const requestModels = [];
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVtestfallback",
      aid: 123456,
      title: "Fallback Summary Test",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 180,
      subtitlePath,
      isDeleted: false,
    });

    const result = await summarizePartFromSubtitle({
      db,
      videoId: video.id,
      bvid: video.bvid,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 180,
      subtitlePath,
      model: "kimi-k2.5",
      apiKey: "key-123",
      apiBaseUrl: "https://example.com/v1",
      apiFormat: "openai-chat",
      workRoot,
      eventLogger: {
        log(event) {
          events.push(event);
        },
      },
      requestSummaryImpl: async (args) => {
        requestModels.push(args.model);
        if (args.model === "kimi-k2.5") {
          throw new Error("Summary request failed: 500 Internal Server Error\n{\"message\":\"Cannot read properties of undefined (reading 'prompt_tokens')\"}");
        }
        return "<2P> 2#00:00 fallback summary";
      },
    });

    assert.deepEqual(requestModels, ["kimi-k2.5", "glm-5"]);
    assert.equal(result.modelUsed, "glm-5");
    assert.equal(result.fallbackUsed, true);
    assert.ok(result.promptPath);
    assert.equal(fs.existsSync(result.promptPath), true);
    assert.match(fs.readFileSync(result.promptPath, "utf8"), /## System Prompt/u);
    assert.match(fs.readFileSync(result.promptPath, "utf8"), /## User Prompt/u);

    const fallbackStarted = events.find((event) => event.action === "llm-fallback" && event.status === "started");
    assert.ok(fallbackStarted);
    assert.equal(fallbackStarted.details.failedModel, "kimi-k2.5");
    assert.equal(fallbackStarted.details.fallbackModel, "glm-5");

    const llmSucceeded = events.find((event) => event.action === "llm" && event.status === "succeeded");
    assert.ok(llmSucceeded);
    assert.equal(llmSucceeded.details.model, "glm-5");
    assert.equal(llmSucceeded.details.requestedModel, "kimi-k2.5");
    assert.equal(llmSucceeded.details.fallbackUsed, true);

    const savedPart = listVideoParts(db, video.id).find((part) => part.page_no === 2);
    assert.equal(savedPart.summary_text, "<2P> 2#00:00 fallback summary");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("summarizePartFromSubtitle writes prompt artifact before a summary request failure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-service-failure-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const subtitlePath = path.join(tempRoot, "p1.srt");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoRoot = process.cwd();
  const repoWorkRoot = path.join(repoRoot, workRoot);
  fs.writeFileSync(subtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "prompt file should still exist",
    "",
  ].join("\n"), "utf8");

  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVpromptfail1",
      aid: 654321,
      title: "Prompt Failure Test",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 45,
      subtitlePath,
      isDeleted: false,
    });

    await assert.rejects(
      summarizePartFromSubtitle({
        db,
        videoId: video.id,
        bvid: video.bvid,
        pageNo: 1,
        cid: 101,
        partTitle: "P1",
        durationSec: 45,
        subtitlePath,
        model: "gpt-test",
        apiKey: "key-123",
        apiBaseUrl: "https://example.com/v1",
        apiFormat: "openai-chat",
        workRoot,
        requestSummaryImpl: async () => {
          throw new Error("Summary request failed: 429 Too Many Requests");
        },
      }),
      /429 Too Many Requests/u,
    );

    const workDir = resolveVideoWorkDir(video, workRoot, repoRoot);
    const promptPath = path.join(workDir, "prompt-p01.md");
    assert.equal(fs.existsSync(promptPath), true);
    assert.match(fs.readFileSync(promptPath, "utf8"), /Prompt P01/u);
    assert.match(fs.readFileSync(promptPath, "utf8"), /## System Prompt/u);
    assert.match(fs.readFileSync(promptPath, "utf8"), /## User Prompt/u);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("writeSummaryArtifacts refreshes per-page prompt files and removes stale prompt files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-artifacts-prompts-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoRoot = process.cwd();
  const repoWorkRoot = path.join(repoRoot, workRoot);
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVpromptart1",
      aid: 789012,
      title: "Prompt Artifact Refresh Test",
      pageCount: 2,
    });

    const subtitlePath1 = path.join(tempRoot, "p1.srt");
    const subtitlePath2 = path.join(tempRoot, "p2.srt");
    fs.writeFileSync(subtitlePath1, [
      "1",
      "00:00:00,000 --> 00:00:02,000",
      "subtitle one",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(subtitlePath2, [
      "1",
      "00:00:00,000 --> 00:00:03,000",
      "subtitle two",
      "",
    ].join("\n"), "utf8");

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 201,
      partTitle: "P1",
      durationSec: 30,
      subtitlePath: subtitlePath1,
      summaryText: "<1P> 1#00:00 summary one",
      summaryHash: "hash-one",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 40,
      subtitlePath: subtitlePath2,
      summaryText: "<2P> 2#00:00 summary two",
      summaryHash: "hash-two",
      isDeleted: false,
    });

    const workDir = resolveVideoWorkDir(video, workRoot, repoRoot);
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, "prompt-p03.md"), "stale", "utf8");

    writeSummaryArtifacts(db, video, workRoot, {
      promptConfigPath: null,
    });

    const promptPath1 = path.join(workDir, "prompt-p01.md");
    const promptPath2 = path.join(workDir, "prompt-p02.md");
    assert.equal(fs.existsSync(promptPath1), true);
    assert.equal(fs.existsSync(promptPath2), true);
    assert.equal(fs.existsSync(path.join(workDir, "prompt-p03.md")), false);
    assert.match(fs.readFileSync(promptPath1, "utf8"), /## System Prompt/u);
    assert.match(fs.readFileSync(promptPath2, "utf8"), /## User Prompt/u);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("writeSummaryArtifacts prefers processed summary text when present", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-artifacts-processed-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoRoot = process.cwd();
  const repoWorkRoot = path.join(repoRoot, workRoot);
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVprocessedpref1",
      aid: 789013,
      title: "Processed Summary Preference Test",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 301,
      partTitle: "P1",
      durationSec: 30,
      summaryText: "<1P>\n1#00:00 原始内容",
      processedSummaryText: "<1P>\n1#00:00 https://paste.rs/example",
      summaryHash: "hash-processed",
      isDeleted: false,
    });

    const artifacts = writeSummaryArtifacts(db, video, workRoot, {
      promptConfigPath: null,
    });

    assert.equal(
      fs.readFileSync(artifacts.summaryPath, "utf8").trim(),
      "<1P>\n1#00:00 https://paste.rs/example",
    );
    assert.equal(
      fs.readFileSync(path.join(resolveVideoWorkDir(video, workRoot), "summary-p01.md"), "utf8").trim(),
      "<1P>\n1#00:00 https://paste.rs/example",
    );
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("writeSummaryArtifacts uses raw summary text during rebuild publish preparation", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-artifacts-rebuild-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoRoot = process.cwd();
  const repoWorkRoot = path.join(repoRoot, workRoot);
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVrebuildraw1",
      aid: 789015,
      title: "Rebuild Summary Raw Preference Test",
      pageCount: 2,
    });
    const rebuildVideo = {
      ...video,
      publish_needs_rebuild: 1,
    };

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 311,
      partTitle: "P1",
      durationSec: 30,
      summaryText: "<1P>\n1#00:00 原始内容一",
      processedSummaryText: "<1P>\nhttps://paste.rs/example",
      summaryHash: "hash-rebuild-1",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 312,
      partTitle: "P2",
      durationSec: 30,
      summaryText: "<2P>\n2#00:00 原始内容二",
      processedSummaryText: "<2P>\nhttps://paste.rs/example",
      summaryHash: "hash-rebuild-2",
      isDeleted: false,
    });

    const artifacts = writeSummaryArtifacts(db, rebuildVideo, workRoot, {
      promptConfigPath: null,
    });

    assert.equal(
      fs.readFileSync(artifacts.summaryPath, "utf8").trim(),
      "<1P>\n1#00:00 原始内容一\n\n<2P>\n2#00:00 原始内容二",
    );
    assert.equal(
      fs.readFileSync(path.join(resolveVideoWorkDir(rebuildVideo, workRoot), "summary-p01.md"), "utf8").trim(),
      "<1P>\n1#00:00 原始内容一",
    );
    assert.equal(
      fs.readFileSync(path.join(resolveVideoWorkDir(rebuildVideo, workRoot), "summary-p02.md"), "utf8").trim(),
      "<2P>\n2#00:00 原始内容二",
    );
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("reindexSummaryTextToPage aligns markers and page-prefixed timestamps to the actual page number", () => {
  const reindexed = reindexSummaryTextToPage(
    "<15P>\n15#00:00 开场\n00:30 继续\n15#01:00 收尾",
    16,
  );

  assert.equal(reindexed, "<16P>\n16#00:00 开场\n00:30 继续\n16#01:00 收尾");
});

test("writeSummaryArtifacts reindexes stored page markers across summary, pending, and per-page views", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "summary-artifacts-reindex-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoRoot = process.cwd();
  const repoWorkRoot = path.join(repoRoot, workRoot);
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVreindexart1",
      aid: 789014,
      title: "Summary Reindex Artifact Test",
      pageCount: 3,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 401,
      partTitle: "P1",
      durationSec: 30,
      summaryText: "<1P>\n1#00:00 第一页",
      summaryHash: "hash-one",
      published: true,
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 402,
      partTitle: "P2",
      durationSec: 40,
      summaryText: "<1P>\n1#00:00 第二页页标错位",
      summaryHash: "hash-two",
      published: false,
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 3,
      cid: 403,
      partTitle: "P3",
      durationSec: 50,
      summaryText: "<2P>\n2#00:00 原始第三页",
      processedSummaryText: "<2P>\n2#00:00 处理后第三页",
      summaryHash: "hash-three",
      published: false,
      isDeleted: false,
    });

    const artifacts = writeSummaryArtifacts(db, video, workRoot, {
      promptConfigPath: null,
    });
    const workDir = resolveVideoWorkDir(video, workRoot, repoRoot);

    assert.equal(
      fs.readFileSync(artifacts.summaryPath, "utf8").trim(),
      [
        "<1P>",
        "1#00:00 第一页",
        "",
        "<2P>",
        "2#00:00 第二页页标错位",
        "",
        "<3P>",
        "3#00:00 处理后第三页",
      ].join("\n"),
    );
    assert.equal(
      fs.readFileSync(artifacts.pendingSummaryPath, "utf8").trim(),
      [
        "<2P>",
        "2#00:00 第二页页标错位",
        "",
        "<3P>",
        "3#00:00 处理后第三页",
      ].join("\n"),
    );
    assert.equal(
      fs.readFileSync(path.join(workDir, "summary-p02.md"), "utf8").trim(),
      "<2P>\n2#00:00 第二页页标错位",
    );
    assert.equal(
      fs.readFileSync(path.join(workDir, "summary-p03.md"), "utf8").trim(),
      "<3P>\n3#00:00 处理后第三页",
    );
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});
