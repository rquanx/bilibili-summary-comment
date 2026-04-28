import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDirectFasterWhisperArgs, buildTranscribeArgs, transcribeWithRetries } from "../scripts/lib/subtitle/transcriber";

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

test("buildDirectFasterWhisperArgs normalizes local binary arguments", () => {
  const originalVadMethod = process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_METHOD;
  const originalVadThreshold = process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_THRESHOLD;
  process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_METHOD = "silero-v4";
  process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_THRESHOLD = "0.4";

  try {
    const args = buildDirectFasterWhisperArgs({
      audioPath: "/tmp/audio.m4a",
      subtitlePath: "/tmp/audio.srt",
      localFasterWhisper: {
        exists: true,
        modelName: "large-v3-turbo",
        modelDir: "/models",
        modelPath: "/models/faster-whisper-large-v3-turbo",
      },
      executableConfig: {
        device: "cuda",
        programPath: "/opt/videocaptioner/bin/Faster-Whisper-XXL/faster-whisper-xxl",
        pathEntries: ["/opt/videocaptioner/bin/Faster-Whisper-XXL"],
      },
    });

    assert.deepEqual(args.slice(0, 5), ["-m", "large-v3-turbo", "--print_progress", "--model_dir", "/models"]);
    assert.ok(args.includes("--compute_type"));
    assert.ok(args.includes("float16"));
    assert.ok(args.includes("--vad_method"));
    assert.ok(args.includes("silero_v4"));
  } finally {
    process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_METHOD = originalVadMethod;
    process.env.VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_THRESHOLD = originalVadThreshold;
  }
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
      resolveLocalFasterWhisperExecutableConfigImpl: () => null,
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
      resolveLocalFasterWhisperExecutableConfigImpl: () => null,
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

test("transcribeWithRetries uses the local FasterWhisper binary directly when available", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-direct-fw-"));
  const audioPath = path.join(tempRoot, "audio.m4a");
  const subtitlePath = path.join(tempRoot, "audio.srt");
  const { progress } = createProgressRecorder();
  const directCalls: Array<{ command: string; args: string[] }> = [];

  fs.writeFileSync(audioPath, "fake-audio", "utf8");

  try {
    await transcribeWithRetries({
      audioPath,
      subtitlePath,
      asr: "faster-whisper",
      bvid: "BVdirect",
      videoTitle: "Direct FasterWhisper Test",
      cid: 3,
      pageNo: 3,
      partTitle: "P3",
      workRoot: tempRoot,
      venvPath: ".3.11",
      progress,
      eventLogger: null,
      resolveLocalFasterWhisperConfigImpl: () => ({
        exists: true,
        modelName: "large-v3-turbo",
        modelDir: "/models",
        modelPath: "/models/faster-whisper-large-v3-turbo",
      }),
      resolveLocalFasterWhisperExecutableConfigImpl: () => ({
        device: "cuda",
        programPath: "/opt/videocaptioner/bin/Faster-Whisper-XXL/faster-whisper-xxl",
        pathEntries: ["/opt/videocaptioner/bin/Faster-Whisper-XXL"],
      }),
      withTranscriptionQueueLockImpl: async (_options, callback) => callback(),
      notifyTranscriptionFailureImpl: async () => {},
      runTranscribeCommandImpl: async () => {
        throw new Error("videocaptioner CLI should not be used when a direct FasterWhisper binary is available");
      },
      runDirectCommandImpl: async (command, args) => {
        directCalls.push({ command, args });
        fs.writeFileSync(subtitlePath, [
          "1",
          "00:00:00,000 --> 00:00:02,000",
          "二进制直调成功",
          "",
        ].join("\n"), "utf8");
        return {
          code: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    assert.equal(directCalls.length, 1);
    assert.equal(directCalls[0]?.command, "/opt/videocaptioner/bin/Faster-Whisper-XXL/faster-whisper-xxl");
    assert.ok(directCalls[0]?.args.includes("--compute_type"));
    assert.match(fs.readFileSync(subtitlePath, "utf8"), /二进制直调成功/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
