import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompositeWriteStream, createWorkFileLogger } from "../scripts/lib/shared/logger";

test("createWorkFileLogger writes structured jsonl entries", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-logger-"));

  try {
    const logger = createWorkFileLogger({
      repoRoot,
      workRoot: "work",
      name: "scheduler",
      label: "BV1TEST",
      context: {
        scope: "test",
      },
    });

    logger.info("hello", {
      step: "setup",
    });
    logger.createStream({
      level: "debug",
      source: "stdout",
    }).write("child output");

    await waitForLogContent(logger.filePath);

    const lines = fs.readFileSync(logger.filePath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].level, "info");
    assert.equal(lines[0].message, "hello");
    assert.deepEqual(lines[0].context, {
      scope: "test",
      step: "setup",
    });
    assert.equal(lines[1].message, "stream-output");
    assert.equal(lines[1].context.source, "stdout");
    assert.equal(lines[1].context.chunk, "child output");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("createCompositeWriteStream forwards writes to every target", () => {
  const writesA: string[] = [];
  const writesB: string[] = [];

  const stream = createCompositeWriteStream(
    {
      write(chunk) {
        writesA.push(String(chunk));
        return true;
      },
    },
    {
      write(chunk) {
        writesB.push(String(chunk));
        return true;
      },
    },
  );

  stream.write("line");
  assert.deepEqual(writesA, ["line"]);
  assert.deepEqual(writesB, ["line"]);
});

async function waitForLogContent(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").trim()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for log file ${filePath}`);
}
