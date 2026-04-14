import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSummaryConfig } from "../scripts/lib/summary/config";
import {
  buildSummaryHttpRequest,
  buildSummaryPromptInput,
  extractSummaryText,
  resolveSummaryApiTarget,
} from "../scripts/lib/summary/client";
import { splitSummaryForComments } from "../scripts/lib/summary/format";
import { normalizeSummaryOutput } from "../scripts/lib/summary/output";
import { resolveSummaryPromptProfile } from "../scripts/lib/summary/prompt-config";

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
