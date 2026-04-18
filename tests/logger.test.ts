import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCompositeWriteStream,
  createLogGroupName,
  createWorkFileLogger,
  formatLogDay,
} from "../scripts/lib/shared/logger";

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

test("createWorkFileLogger writes grouped logs under the requested day directory", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-logger-group-"));
  const startedAt = new Date("2026-04-11T17:24:11.706Z");
  const logDay = formatLogDay(startedAt);
  const logGroup = createLogGroupName("summary", "scheduler", startedAt);

  try {
    const logger = createWorkFileLogger({
      repoRoot,
      workRoot: "work",
      name: "summary",
      day: logDay,
      group: logGroup,
    });

    logger.info("grouped");
    await waitForLogContent(logger.filePath);

    const relativePath = path.relative(repoRoot, logger.filePath).split(path.sep).join("/");
    assert.match(relativePath, new RegExp(`^work/logs/${logDay}/${logGroup}/.+-summary\\.jsonl$`, "u"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("createWorkFileLogger keeps readable unicode labels in filenames", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-logger-unicode-"));

  try {
    const logger = createWorkFileLogger({
      repoRoot,
      workRoot: "work",
      name: "pipeline",
      label: "小泽又沐风2026.04.13 19.27.43 纯净版__BV1TEST",
    });

    logger.info("unicode");
    await waitForLogContent(logger.filePath);

    const basename = path.basename(logger.filePath);
    assert.match(basename, /小泽又沐风2026\.04\.13-19\.27\.43-纯净版__BV1TEST/u);
    assert.match(basename, /\.jsonl$/u);
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
