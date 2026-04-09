import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../scripts/lib/shared/runtime-tools.js";

test("getRepoRoot resolves to the project root", () => {
  const repoRoot = getRepoRoot();
  const hasSchedulerEntry =
    fs.existsSync(path.join(repoRoot, "scripts", "commands", "run-scheduler.js")) ||
    fs.existsSync(path.join(repoRoot, "scripts", "commands", "run-scheduler.ts"));

  assert.equal(fs.existsSync(path.join(repoRoot, "package.json")), true);
  assert.equal(hasSchedulerEntry, true);
});
