import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "./runtime-tools.mjs";
import { listPendingPublishParts, listVideoParts } from "./storage.mjs";

export function writePartSummaryArtifact({ bvid, pageNo, summaryText, workRoot = "work" }) {
  const workDir = path.join(getRepoRoot(), workRoot, bvid);
  fs.mkdirSync(workDir, { recursive: true });

  const partSummaryPath = path.join(workDir, `summary-p${String(pageNo).padStart(2, "0")}.md`);
  const normalizedSummary = String(summaryText ?? "").trim();
  fs.writeFileSync(partSummaryPath, normalizedSummary ? `${normalizedSummary}\n` : "", "utf8");
  return partSummaryPath;
}

export function writeSummaryArtifacts(db, video, workRoot = "work") {
  const workDir = path.join(getRepoRoot(), workRoot, video.bvid);
  fs.mkdirSync(workDir, { recursive: true });

  const allSummaryText = listVideoParts(db, video.id)
    .map((part) => String(part.summary_text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const pendingSummaryText = listPendingPublishParts(db, video.id)
    .map((part) => String(part.summary_text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const summaryPath = path.join(workDir, "summary.md");
  const pendingPath = path.join(workDir, "pending-summary.md");

  fs.writeFileSync(summaryPath, allSummaryText ? `${allSummaryText}\n` : "", "utf8");
  fs.writeFileSync(pendingPath, pendingSummaryText ? `${pendingSummaryText}\n` : "", "utf8");

  return {
    summaryPath,
    pendingSummaryPath: pendingPath,
  };
}
