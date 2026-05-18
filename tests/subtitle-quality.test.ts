import test from "node:test";
import assert from "node:assert/strict";
import { inspectSubtitleQuality, isLikelyVolunteerCreditCue } from "../src/domains/subtitle/quality";

test("isLikelyVolunteerCreditCue matches the known promotional outro cue", () => {
  assert.equal(
    isLikelyVolunteerCreditCue("请不吝点赞 订阅 订阅 转发 打赏支持明镜与点点栏目"),
    true,
  );
  assert.equal(
    isLikelyVolunteerCreditCue("请不吝点赞，订阅、订阅、转发，打赏支持明镜与点点栏目"),
    true,
  );
});

test("inspectSubtitleQuality removes the promotional outro cue and preserves normal subtitles", () => {
  const result = inspectSubtitleQuality([
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "正常内容",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "请不吝点赞 订阅 订阅 转发 打赏支持明镜与点点栏目",
    "",
    "3",
    "00:00:04,000 --> 00:00:06,000",
    "后续内容",
    "",
  ].join("\n"));

  assert.equal(result.removedCueCount, 1);
  assert.equal(result.remainingCueCount, 2);
  assert.equal(result.severeVolunteerCreditIssue, false);
  assert.match(result.sanitizedSrt, /正常内容/u);
  assert.match(result.sanitizedSrt, /后续内容/u);
  assert.doesNotMatch(result.sanitizedSrt, /明镜与点点栏目/u);
});
