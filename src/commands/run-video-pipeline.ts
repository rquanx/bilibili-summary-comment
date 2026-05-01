import {
  addCookieOptions,
  addDatabaseOption,
  addSummaryApiOptions,
  addVideoIdentityOptions,
  addWorkRootOption,
  createCliCommand,
  runCli,
} from "../shared/cli/tools";
import { printPipelineFailure, runVideoPipeline } from "../domains/video/pipeline-runner";

let activeEventLogger = null;

const command = addSummaryApiOptions(
  addWorkRootOption(
    addDatabaseOption(
      addVideoIdentityOptions(
        addCookieOptions(
          createCliCommand({
            name: "run-video-pipeline",
            description: "Run the full subtitle, summary, and publish pipeline for one video.",
          })
            .option("--venv-path <path>", "Optional. Python virtual environment path. Default: .3.11")
            .option("--asr <engine>", "Optional. VideoCaptioner ASR engine. Default: faster-whisper")
            .option("--publish", "Optional. Publish pending summaries after generation.")
            .option("--force-summary", "Optional. Regenerate summaries even if already present."),
          { required: true },
        ),
      ),
    ),
  ),
);

await runCli({
  command,
  async handler(args) {
    return runVideoPipeline(args, {
      onEventLogger(eventLogger) {
        activeEventLogger = eventLogger;
      },
    });
  },
  onError(error) {
    printPipelineFailure(error, activeEventLogger);
    process.exitCode = 1;
    return undefined;
  },
});
