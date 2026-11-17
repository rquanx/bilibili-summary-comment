import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "dotenv";
import { getRepoRoot } from "../shared/runtime-tools";
import { reportSyncStatus } from "../domains/scheduler/sync-status-alert";

const { values } = parseArgs({ options: {
  task: { type: "string" }, status: { type: "string" },
  "log-path": { type: "string", default: "未提供" },
  "dry-run": { type: "boolean", default: false },
} });
config({ path: path.join(getRepoRoot(), ".env"), quiet: true });
try {
  const result = await reportSyncStatus({
    task: values.task as Parameters<typeof reportSyncStatus>[0]["task"],
    status: values.status as Parameters<typeof reportSyncStatus>[0]["status"],
    logPath: values["log-path"]!,
    stateDirectory: path.join(getRepoRoot(), "work/logs/sync-alerts"),
    enabled: process.env.SYNC_SERVERCHAN_ALERTS_ENABLED === "true",
    dryRun: values["dry-run"],
  });
  console.log(JSON.stringify(result));
  if (result.action === "missing-send-key") process.exitCode = 1;
} catch {
  // Never print request URLs / causes: the ServerChan URL contains the send key.
  console.error("Sync alert delivery/state update failed; check ServerChan configuration and local state permissions.");
  process.exitCode = 1;
}
