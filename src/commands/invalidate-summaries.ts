import {
  addDatabaseOption,
  addVideoIdentityOptions,
  createCliCommand,
  parsePositiveIntegerArg,
  parseOptionalPositiveInteger,
  requireNonEmptyString,
  runCli,
} from "../shared/cli/tools";
import { openDatabase } from "../infra/db/index";
import { invalidateSummaries } from "../domains/summary/index";

const command = addDatabaseOption(
  addVideoIdentityOptions(
    createCliCommand({
      name: "invalidate-summaries",
      description: "Clear stored summary artifacts so videos can be regenerated with the current summary pipeline.",
    })
      .option("--all", "Optional. Invalidate summaries for every video in the database.")
      .option("--recent-days <days>", "Optional. Only invalidate parts updated within the most recent N days.", parsePositiveIntegerArg)
      .option("--from <timestamp>", "Optional. Only invalidate parts updated at or after this time. Accepts ISO timestamps or YYYY-MM-DD.")
      .option("--to <timestamp>", "Optional. Only invalidate parts updated at or before this time. Accepts ISO timestamps or YYYY-MM-DD.")
      .option("--reason <text>", "Optional. Stored rebuild reason for publish recovery.")
      .option("--dry-run", "Optional. Preview what would be invalidated without modifying the database."),
  ),
);

await runCli({
  command,
  async handler(args) {
    const all = Boolean(args.all);
    const bvid = String(args.bvid ?? "").trim() || null;
    const aid = parseOptionalPositiveInteger(args.aid ?? args.oid ?? null, "aid");
    const recentDays = parseOptionalPositiveInteger(args["recent-days"] ?? args.recentDays ?? null, "recent-days");
    const fromIso = String(args.from ?? "").trim() || null;
    const toIso = String(args.to ?? "").trim() || null;
    const dryRun = Boolean(args["dry-run"] ?? args.dryRun);

    if (!all && !bvid && aid === null && recentDays === null && !fromIso && !toIso) {
      throw new Error("Provide --all, a time filter, or one of --bvid/--aid.");
    }

    const dbPath = requireNonEmptyString(args.db ?? "work/pipeline.sqlite3", "db");
    const db = openDatabase(dbPath);

    try {
      return invalidateSummaries(db, {
        all,
        bvid,
        aid,
        recentDays,
        fromIso,
        toIso,
        reason: String(args.reason ?? "").trim() || null,
        dryRun,
      });
    } finally {
      db.close?.();
    }
  },
});
