import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTranscribeArgs, transcribeWithRetries } from "../scripts/lib/subtitle/transcriber";

function createProgressRecorder() {
  const messages: string[] = [];

  return {
    messages,
    progress: {
      logPartStage(pageNo: number, stage: string, message: string) {
        messages.push(`P${pageNo}:${stage}:${message}`);
      },
    },
  };
}

test("buildTranscribeArgs requests Chinese transcription", () => {
  const args = buildTranscribeArgs({
    audioPath: "audio.m4a",
    subtitlePath: "subtitle.srt",
    engine: "faster-whisper",
    localFasterWhisper: null,
  });

  const languageIndex = args.indexOf("--language");
  assert.notEqual(languageIndex, -1);
  assert.equal(args[languageIndex + 1], "zh");
});

test("transcribeWithRetries removes sparse volunteer-credit cues without fallback", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-clean-"));
  const subtitlePath = path.join(tempRoot, "subtitle.srt");
  const { progress } = createProgressRecorder();
  const engineCalls: string[] = [];

  try {
    await transcribeWithRetries({
      audioPath: path.join(tempRoot, "audio.m4a"),
      subtitlePath,
      asr: "faster-whisper",
      bvid: "BVclean",
      videoTitle: "Subtitle Clean Test",
      cid: 1,
      pageNo: 1,
      partTitle: "P1",
      workRoot: tempRoot,
      venvPath: ".3.11",
      progress,
      eventLogger: null,
      resolveLocalFasterWhisperConfigImpl: () => null,
      withTranscriptionQueueLockImpl: async (_options, callback) => callback(),
      notifyTranscriptionFailureImpl: async () => {},
      runTranscribeCommandImpl: async (_moduleName, args) => {
        engineCalls.push(String(args[args.indexOf("--asr") + 1] ?? ""));
        fs.writeFileSync(subtitlePath, [
          "1",
          "00:00:00,000 --> 00:00:03,000",
          "正常内容",
          "",
          "2",
          "00:00:03,000 --> 00:00:05,000",
          "字 幕志愿者 李宗盛",
          "",
          "3",
          "00:00:05,000 --> 00:00:08,000",
          "后续内容",
          "",
        ].join("\n"), "utf8");

        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    assert.deepEqual(engineCalls, ["faster-whisper"]);
    const cleaned = fs.readFileSync(subtitlePath, "utf8");
    assert.match(cleaned, /正常内容/u);
    assert.match(cleaned, /后续内容/u);
    assert.doesNotMatch(cleaned, /李宗盛/u);
    assert.match(cleaned, /^1\r?\n00:00:00,000 --> 00:00:03,000/um);
    assert.match(cleaned, /\n\n2\r?\n00:00:05,000 --> 00:00:08,000/um);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("transcribeWithRetries falls back to bijian when volunteer-credit cues dominate", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-fallback-"));
  const subtitlePath = path.join(tempRoot, "subtitle.srt");
  const { progress } = createProgressRecorder();
  const engineCalls: Array<{ engine: string; language: string | null }> = [];

  try {
    await transcribeWithRetries({
      audioPath: path.join(tempRoot, "audio.m4a"),
      subtitlePath,
      asr: "faster-whisper",
      bvid: "BVfallback",
      videoTitle: "Subtitle Fallback Test",
      cid: 2,
      pageNo: 2,
      partTitle: "P2",
      workRoot: tempRoot,
      venvPath: ".3.11",
      progress,
      eventLogger: null,
      resolveLocalFasterWhisperConfigImpl: () => null,
      withTranscriptionQueueLockImpl: async (_options, callback) => callback(),
      notifyTranscriptionFailureImpl: async () => {},
      runTranscribeCommandImpl: async (_moduleName, args) => {
        const engine = String(args[args.indexOf("--asr") + 1] ?? "");
        const languageIndex = args.indexOf("--language");
        engineCalls.push({
          engine,
          language: languageIndex >= 0 ? String(args[languageIndex + 1] ?? "") : null,
        });

        if (engine === "faster-whisper") {
          fs.writeFileSync(subtitlePath, [
            "1",
            "00:00:00,000 --> 00:00:02,000",
            "字幕志愿者 李宗盛",
            "",
            "2",
            "00:00:02,000 --> 00:00:04,000",
            "字 幕志愿者 李宗盛",
            "",
            "3",
            "00:00:04,000 --> 00:00:06,000",
            "字幕志愿者 李宗盛 字幕志愿者 李宗盛",
            "",
            "4",
            "00:00:06,000 --> 00:00:08,000",
            "字 幕志愿者",
            "",
          ].join("\n"), "utf8");
          return {
            code: 0,
            stdout: "",
            stderr: "",
          };
        }

        if (engine === "bijian") {
          fs.writeFileSync(subtitlePath, [
            "1",
            "00:00:00,000 --> 00:00:03,000",
            "重新识别成功",
            "",
            "2",
            "00:00:03,000 --> 00:00:05,000",
            "这是正常中文字幕",
            "",
          ].join("\n"), "utf8");
          return {
            code: 0,
            stdout: "",
            stderr: "",
          };
        }

        throw new Error(`Unexpected engine ${engine}`);
      },
    });

    assert.deepEqual(engineCalls.map((item) => item.engine), ["faster-whisper", "bijian"]);
    assert.deepEqual(engineCalls.map((item) => item.language), ["zh", "zh"]);
    const finalSubtitle = fs.readFileSync(subtitlePath, "utf8");
    assert.match(finalSubtitle, /重新识别成功/u);
    assert.match(finalSubtitle, /正常中文字幕/u);
    assert.doesNotMatch(finalSubtitle, /李宗盛/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
