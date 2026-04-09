import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../shared/runtime-tools.mjs";
import { listPendingPublishParts, listVideoParts } from "../db/index.mjs";

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
  const activeParts = listVideoParts(db, video.id);

  const allSummaryText = activeParts
    .map((part) => String(part.summary_text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const pendingSourceParts = Number(video.publish_needs_rebuild)
    ? activeParts.filter((part) => String(part.summary_text ?? "").trim())
    : listPendingPublishParts(db, video.id);

  const pendingSummaryText = pendingSourceParts
    .map((part) => String(part.summary_text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const summaryPath = path.join(workDir, "summary.md");
  const pendingPath = path.join(workDir, "pending-summary.md");

  fs.writeFileSync(summaryPath, allSummaryText ? `${allSummaryText}\n` : "", "utf8");
  fs.writeFileSync(pendingPath, pendingSummaryText ? `${pendingSummaryText}\n` : "", "utf8");
  rewritePerPageSummaryViews(workDir, activeParts);

  return {
    summaryPath,
    pendingSummaryPath: pendingPath,
  };
}

function rewritePerPageSummaryViews(workDir, parts) {
  const currentFileNames = new Set();
  for (const part of parts) {
    const fileName = `summary-p${String(part.page_no).padStart(2, "0")}.md`;
    currentFileNames.add(fileName);
    const filePath = path.join(workDir, fileName);
    const normalizedSummary = String(part.summary_text ?? "").trim();
    fs.writeFileSync(filePath, normalizedSummary ? `${normalizedSummary}\n` : "", "utf8");
  }

  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    if (!/^summary-p\d+\.md$/u.test(entry.name)) {
      continue;
    }

    if (currentFileNames.has(entry.name)) {
      continue;
    }

    fs.rmSync(path.join(workDir, entry.name), { force: true });
  }
}
