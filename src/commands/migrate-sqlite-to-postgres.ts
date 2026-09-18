import { createCliCommand, parsePositiveIntegerArg, runCli } from "../shared/cli/tools";
import { migrateSqliteToPostgres } from "../infra/db/sqlite-postgres-migration";

const command = createCliCommand({
  name: "migrate-sqlite-to-postgres",
  description: "Migrate the complete SQLite pipeline database into PostgreSQL.",
})
  .requiredOption("--sqlite <path>", "Required. Source SQLite database path.")
  .requiredOption("--postgres-url <url>", "Required. PostgreSQL connection URL.")
  .option("--schema <path>", "Optional. PostgreSQL schema SQL path.", "postgres/schema.sql")
  .option("--batch-size <count>", "Optional. Rows per INSERT batch. Default: 500.", parsePositiveIntegerArg, 500)
  .option("--reset", "Optional. Truncate and replace existing PostgreSQL data.");

await runCli({
  command,
  async handler(args) {
    return migrateSqliteToPostgres({
      sqlitePath: String(args.sqlite),
      postgresUrl: String(args["postgres-url"]),
      schemaPath: String(args.schema),
      batchSize: Number(args["batch-size"]),
      reset: Boolean(args.reset),
      onLog(message) {
        process.stderr.write(`[migration] ${message}\n`);
      },
    });
  },
});
