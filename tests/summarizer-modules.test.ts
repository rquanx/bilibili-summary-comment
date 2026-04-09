import test from "node:test";
import assert from "node:assert/strict";
import { resolveSummaryConfig } from "../scripts/lib/summary/config.js";
import {
  buildSummaryHttpRequest,
  buildSummaryPromptInput,
  extractSummaryText,
  resolveSummaryApiTarget,
} from "../scripts/lib/summary/client.js";
import { normalizeSummaryOutput } from "../scripts/lib/summary/output.js";

test("resolveSummaryConfig normalizes args and env values", () => {
  const config = resolveSummaryConfig(
    {
      model: "gpt-test",
      "api-base-url": "https://example.com/v1/",
      "api-format": "OPENAI-CHAT",
    },
    {
      SUMMARY_API_KEY: "key-123",
    },
  );

  assert.equal(config.model, "gpt-test");
  assert.equal(config.apiKey, "key-123");
  assert.equal(config.apiBaseUrl, "https://example.com/v1");
  assert.equal(config.apiFormat, "openai-chat");
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

  assert.equal(normalized, "<1P>\n00:01 first\n\n00:20 second");
});
