import { printJson } from "./lib/bili-comment-utils.mjs";
import {
  addCookieOptions,
  addDatabaseOption,
  addSummaryApiOptions,
  addVideoIdentityOptions,
  addWorkRootOption,
  createCliCommand,
  parseCliArgs,
} from "./lib/cli-tools.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { printPipelineFailure, runVideoPipeline } from "./lib/video-pipeline-runner.mjs";

loadDotEnvIfPresent();

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

async function main() {
  const args = parseCliArgs(command);
  const result = await runVideoPipeline(args, {
    onEventLogger(eventLogger) {
      activeEventLogger = eventLogger;
    },
  });
  printJson(result);
}

main().catch((error) => {
  printPipelineFailure(error, activeEventLogger);
  process.exitCode = 1;
});
