import {
  addDatabaseOption,
  addSummaryApiOptions,
  addWorkRootOption,
  createCliCommand,
  runCli,
} from "../shared/cli/tools";
import { runLocalVideoPipeline } from "../domains/local-video/pipeline-runner";

const command = addSummaryApiOptions(
  addWorkRootOption(
    addDatabaseOption(
      createCliCommand({
        name: "run-local-video-pipeline",
        description: "Transcribe and summarize local video files without enabling comment publishing.",
      })
        .requiredOption("--input-dir <path>", "Required. Directory containing local video files.")
        .option("--title <title>", "Optional. Group title. Defaults to the common file-name prefix.")
        .option("--id <id>", "Optional. Stable local identity override.")
        .option("--venv-path <path>", "Optional. Python virtual environment path. Default: .3.11")
        .option("--asr <engine>", "Optional. ASR engine. Default: funasr")
        .option("--force-summary", "Optional. Regenerate summaries even if already present."),
    ),
  ),
);

await runCli({
  command,
  handler: runLocalVideoPipeline,
});
