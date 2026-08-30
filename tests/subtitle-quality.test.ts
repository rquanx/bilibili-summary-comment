import test from "node:test";
import assert from "node:assert/strict";
import { inspectSubtitleQuality, isLikelyVolunteerCreditCue } from "../src/domains/subtitle/quality";

test("isLikelyVolunteerCreditCue matches the known promotional outro cue", () => {
  assert.equal(
    isLikelyVolunteerCreditCue("请 不吝点赞 订阅 转发 打赏支持明镜与点点栏目"),
    true,
  );
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

test("inspectSubtitleQuality rejects a silent part containing only promotional hallucinations", () => {
  const result = inspectSubtitleQuality([
    "1",
    "00:00:35,480 --> 00:00:36,880",
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "",
    "2",
    "00:01:20,600 --> 00:01:22,000",
    "请 不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "",
    "3",
    "00:02:00,640 --> 00:02:08,880",
    "请 不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
    "",
  ].join("\n"));

  assert.equal(result.removedCueCount, 3);
  assert.equal(result.remainingCueCount, 0);
  assert.equal(result.severeVolunteerCreditIssue, true);
  assert.equal(result.sanitizedSrt, "");
});
