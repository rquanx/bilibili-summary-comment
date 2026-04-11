import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildLocalFasterWhisperExecutableDirCandidates,
  buildLocalFasterWhisperModelPathCandidates,
  inferFasterWhisperModelName,
  prependPathEntries,
  resolveLocalFasterWhisperConfig,
  resolveLocalFasterWhisperExecutableConfig,
} from "../scripts/lib/subtitle/faster-whisper-config";

test("model path candidates prefer explicit env config before LocalAppData fallback", () => {
  const env = {
    VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH: "D:\\models\\custom-fw",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };

  assert.deepEqual(buildLocalFasterWhisperModelPathCandidates(env), [
    "D:\\models\\custom-fw",
    "C:\\Users\\tester\\AppData\\Local\\VideoCaptioner\\AppData\\models\\faster-whisper-large-v3-turbo",
  ]);
});

test("resolveLocalFasterWhisperConfig infers model name from the directory name", () => {
  const env = {
    VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH: "D:\\models\\faster-whisper-large-v3",
  };

  const config = resolveLocalFasterWhisperConfig({
    env,
    existsSync: (targetPath) => path.resolve(targetPath) === path.resolve("D:\\models\\faster-whisper-large-v3"),
  });

  assert.equal(config.modelName, "large-v3");
  assert.equal(config.exists, true);
  assert.equal(config.modelDir, path.resolve("D:\\models"));
});

test("executable dir candidates include configured and LocalAppData locations", () => {
  const env = {
    VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN: "D:\\fw-bin",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };

  assert.deepEqual(buildLocalFasterWhisperExecutableDirCandidates(env), [
    "D:\\fw-bin",
    "C:\\Users\\tester\\AppData\\Local\\VideoCaptioner\\resource\\bin\\Faster-Whisper-XXL",
    "C:\\Users\\tester\\AppData\\Local\\VideoCaptioner\\resource\\bin",
  ]);
});

test("resolveLocalFasterWhisperExecutableConfig picks the first existing program and infers device", () => {
  const env = {
    VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN: "D:\\fw-bin",
  };

  const existingPaths = new Set([
    path.resolve("D:\\fw-bin"),
    path.resolve("D:\\fw-bin\\faster-whisper-xxl.exe"),
  ]);
  const config = resolveLocalFasterWhisperExecutableConfig({
    env,
    existsSync: (targetPath) => existingPaths.has(path.resolve(targetPath)),
  });

  assert.equal(config.device, "cuda");
  assert.equal(config.programPath, path.resolve("D:\\fw-bin\\faster-whisper-xxl.exe"));
  assert.deepEqual(config.pathEntries, [path.resolve("D:\\fw-bin")]);
});

test("prependPathEntries keeps order while removing duplicates", () => {
  const result = prependPathEntries("C:\\two;C:\\three", ["C:\\one", "C:\\two"]);

  assert.equal(result, "C:\\one;C:\\two;C:\\three");
});

test("inferFasterWhisperModelName falls back to the default model for unknown names", () => {
  assert.equal(inferFasterWhisperModelName("mystery-model"), "large-v3-turbo");
});
