import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildLocalFasterWhisperExecutableDirCandidates,
  buildLocalFasterWhisperModelPathCandidates,
  findFasterWhisperProgramInDir,
  inferFasterWhisperModelName,
  inferFasterWhisperDevice,
  prependPathEntries,
  resolveLocalFasterWhisperConfig,
  resolveLocalFasterWhisperExecutableConfig,
} from "../src/domains/subtitle/faster-whisper-config";

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

test("model path candidates include Linux user-data fallback", () => {
  const env = {
    HOME: "/home/tester",
  };

  assert.deepEqual(buildLocalFasterWhisperModelPathCandidates(env), [
    path.join("/home/tester", ".local", "share", "VideoCaptioner", "models", "faster-whisper-large-v3-turbo"),
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
    "/opt/videocaptioner/bin/Faster-Whisper-XXL",
    "/opt/videocaptioner/bin",
    "/usr/local/bin",
  ]);
});

test("executable dir candidates include Linux fallback locations", () => {
  const env = {
    HOME: "/home/tester",
  };

  assert.deepEqual(buildLocalFasterWhisperExecutableDirCandidates(env), [
    path.join("/home/tester", ".local", "share", "VideoCaptioner", "resource", "bin", "Faster-Whisper-XXL"),
    path.join("/home/tester", ".local", "share", "VideoCaptioner", "resource", "bin"),
    "/opt/videocaptioner/bin/Faster-Whisper-XXL",
    "/opt/videocaptioner/bin",
    "/usr/local/bin",
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
    statSync: (targetPath) => ({
      isFile: () => path.resolve(targetPath) === path.resolve("D:\\fw-bin\\faster-whisper-xxl.exe"),
      isDirectory: () => path.resolve(targetPath) === path.resolve("D:\\fw-bin"),
    }),
  });

  assert.equal(config.device, "cuda");
  assert.equal(config.programPath, path.resolve("D:\\fw-bin\\faster-whisper-xxl.exe"));
  assert.deepEqual(config.pathEntries, [path.resolve("D:\\fw-bin")]);
});

test("resolveLocalFasterWhisperExecutableConfig accepts a Linux program path directly", () => {
  const env = {
    VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN: "/opt/faster-whisper/faster-whisper-xxl",
  };

  const existingPaths = new Set([
    path.resolve("/opt/faster-whisper/faster-whisper-xxl"),
  ]);
  const config = resolveLocalFasterWhisperExecutableConfig({
    env,
    existsSync: (targetPath) => existingPaths.has(path.resolve(targetPath)),
    statSync: () => ({
      isFile: () => true,
      isDirectory: () => false,
    }),
  });

  assert.equal(config.device, "cuda");
  assert.equal(config.programPath, path.resolve("/opt/faster-whisper/faster-whisper-xxl"));
  assert.deepEqual(config.pathEntries, [path.resolve("/opt/faster-whisper")]);
});

test("findFasterWhisperProgramInDir finds a Linux binary inside a directory", () => {
  const existingPaths = new Set([
    path.resolve("/opt/videocaptioner/bin"),
    path.resolve("/opt/videocaptioner/bin/faster-whisper-xxl"),
  ]);

  const programPath = findFasterWhisperProgramInDir(
    "/opt/videocaptioner/bin",
    (targetPath) => existingPaths.has(path.resolve(targetPath)),
    (targetPath) => ({
      isFile: () => path.resolve(targetPath) === path.resolve("/opt/videocaptioner/bin/faster-whisper-xxl"),
      isDirectory: () => path.resolve(targetPath) === path.resolve("/opt/videocaptioner/bin"),
    }),
  );

  assert.equal(programPath, path.join("/opt/videocaptioner/bin", "faster-whisper-xxl"));
});

test("findFasterWhisperProgramInDir does not treat a same-named directory as the executable", () => {
  const existingPaths = new Set([
    path.resolve("/opt/videocaptioner/bin/Faster-Whisper-XXL"),
    path.resolve("/opt/videocaptioner/bin/Faster-Whisper-XXL/faster-whisper-xxl"),
  ]);

  const programPath = findFasterWhisperProgramInDir(
    "/opt/videocaptioner/bin/Faster-Whisper-XXL",
    (targetPath) => existingPaths.has(path.resolve(targetPath)),
    (targetPath) => ({
      isFile: () => path.resolve(targetPath) === path.resolve("/opt/videocaptioner/bin/Faster-Whisper-XXL/faster-whisper-xxl"),
      isDirectory: () => path.resolve(targetPath) === path.resolve("/opt/videocaptioner/bin/Faster-Whisper-XXL"),
    }),
  );

  assert.equal(programPath, path.join("/opt/videocaptioner/bin/Faster-Whisper-XXL", "faster-whisper-xxl"));
});

test("prependPathEntries keeps order while removing duplicates", () => {
  const result = prependPathEntries("C:\\two;C:\\three", ["C:\\one", "C:\\two"]);

  assert.equal(result, "C:\\one;C:\\two;C:\\three");
});

test("inferFasterWhisperModelName falls back to the default model for unknown names", () => {
  assert.equal(inferFasterWhisperModelName("mystery-model"), "large-v3-turbo");
});

test("inferFasterWhisperDevice honors explicit device overrides", () => {
  assert.equal(inferFasterWhisperDevice("/opt/videocaptioner/bin/faster-whisper", "cuda"), "cuda");
  assert.equal(inferFasterWhisperDevice("/opt/videocaptioner/bin/faster-whisper-xxl", "cpu"), "cpu");
});
