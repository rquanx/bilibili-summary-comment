import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getRepoRoot,
  runCommand,
  withSuppressedExperimentalWarning,
} from "../src/shared/runtime-tools";

test("getRepoRoot resolves to the project root", () => {
  const repoRoot = getRepoRoot();
  const hasSchedulerEntry =
    fs.existsSync(path.join(repoRoot, "src", "commands", "run-scheduler.js")) ||
    fs.existsSync(path.join(repoRoot, "src", "commands", "run-scheduler.ts"));

  assert.equal(fs.existsSync(path.join(repoRoot, "package.json")), true);
  assert.equal(hasSchedulerEntry, true);
});

test("runCommand can stream stdout and stderr to separate destinations", async () => {
  const streamedStdout: string[] = [];
  const streamedStderr: string[] = [];

  const result = await runCommand(
    process.execPath,
    ["-e", 'process.stdout.write("stdout-line\\n"); process.stderr.write("stderr-line\\n");'],
    {
      streamOutput: true,
      stdoutStream: {
        write(chunk) {
          streamedStdout.push(String(chunk));
          return true;
        },
      },
      stderrStream: {
        write(chunk) {
          streamedStderr.push(String(chunk));
          return true;
        },
      },
    },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "stdout-line\n");
  assert.equal(result.stderr, "stderr-line\n");
  assert.deepEqual(streamedStdout, ["stdout-line\n"]);
  assert.deepEqual(streamedStderr, ["stderr-line\n"]);
});

test("withSuppressedExperimentalWarning appends the sqlite warning filter", () => {
  const env = withSuppressedExperimentalWarning({
    SAMPLE: "value",
  });

  assert.equal(env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning");
  assert.equal(env.SAMPLE, "value");
});

test("withSuppressedExperimentalWarning preserves existing warning settings", () => {
  const withSpecificFilter = withSuppressedExperimentalWarning({
    NODE_OPTIONS: "--trace-warnings",
  });
  const withNoWarnings = withSuppressedExperimentalWarning({
    NODE_OPTIONS: "--no-warnings",
  });

  assert.equal(
    withSpecificFilter.NODE_OPTIONS,
    "--trace-warnings --disable-warning=ExperimentalWarning",
  );
  assert.equal(withNoWarnings.NODE_OPTIONS, "--no-warnings");
});
