import { printErrorJson, printJson } from "./lib/bili-comment-utils.mjs";
import { resolveCleanupConfig } from "./lib/app-config.mjs";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parseCliArgs,
  parsePositiveIntegerArg,
} from "./lib/cli-tools.mjs";
import { cleanupOldWorkDirectories } from "./lib/scheduler-tasks.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "cleanup-work-files",
      description: "Remove stale work directories for old videos.",
    }),
  ),
)
  .option("--cleanup-days <days>", "Optional. Remove files older than this many days.", parsePositiveIntegerArg);

async function main() {
  const args = parseCliArgs(command);
  const config = resolveCleanupConfig(args);

  const result = await cleanupOldWorkDirectories({
    dbPath: config.dbPath,
    workRoot: config.workRoot,
    olderThanDays: config.olderThanDays,
    onLog(message) {
      process.stderr.write(`[cleanup-work] ${message}\n`);
    },
  });

  printJson({
    ok: true,
    cutoffIso: result.cutoffIso,
    candidateCount: result.candidates.length,
    removedCount: result.removedDirectories.length,
    missingCount: result.missingDirectories.length,
    removedDirectories: result.removedDirectories,
  });
}

main().catch((error) => {
  printErrorJson(error);
});
