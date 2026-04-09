import { resolveCleanupConfig } from "../lib/config/app-config.ts";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools.ts";
import { cleanupOldWorkDirectories } from "../lib/scheduler/index.ts";

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "cleanup-work-files",
      description: "Remove stale work directories for old videos.",
    }),
  ),
)
  .option("--cleanup-days <days>", "Optional. Remove files older than this many days.", parsePositiveIntegerArg);

await runCli({
  command,
  async handler(args) {
    const config = resolveCleanupConfig(args);

    const result = await cleanupOldWorkDirectories({
      dbPath: config.dbPath,
      workRoot: config.workRoot,
      olderThanDays: config.olderThanDays,
      onLog(message) {
        process.stderr.write(`[cleanup-work] ${message}\n`);
      },
    });

    return {
      ok: true,
      cutoffIso: result.cutoffIso,
      candidateCount: result.candidates.length,
      removedCount: result.removedDirectories.length,
      missingCount: result.missingDirectories.length,
      removedDirectories: result.removedDirectories,
    };
  },
});
