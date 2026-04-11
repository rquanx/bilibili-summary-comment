import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getRepoRoot, runCommand } from "../scripts/lib/shared/runtime-tools";

test("getRepoRoot resolves to the project root", () => {
  const repoRoot = getRepoRoot();
  const hasSchedulerEntry =
    fs.existsSync(path.join(repoRoot, "scripts", "commands", "run-scheduler.js")) ||
    fs.existsSync(path.join(repoRoot, "scripts", "commands", "run-scheduler.ts"));

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
