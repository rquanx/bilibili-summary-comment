import fs from "node:fs";
import path from "node:path";
import { buildSummarySegmentsFromSrt, formatSummaryTime } from "../subtitle/srt-utils";
import { ensureVideoWorkDir } from "../shared/work-paths";
import {
  getPreferredSummaryText,
  listPendingPublishParts,
  listVideoParts,
  reindexSummaryTextToPage,
} from "../db/index";
import { buildSummaryPromptInput } from "./client";
import { resolveSummaryPromptProfile } from "./prompt-config";
import type { Db, SummaryArtifacts, VideoPartRecord, VideoRecord } from "../db/index";

export function writePartSummaryArtifact({
  db = null,
  video,
  pageNo,
  summaryText,
  workRoot = "work",
}: {
  db?: Db | null;
  video: Pick<VideoRecord, "id" | "bvid" | "title"> & Partial<Pick<VideoRecord, "owner_mid" | "owner_name" | "owner_dir_name" | "work_dir_name">>;
  pageNo: number;
  summaryText: string | null | undefined;
  workRoot?: string;
}): string {
  const workDir = ensureVideoWorkDir({
    db,
    video,
    workRoot,
  });

  const partSummaryPath = path.join(workDir, `summary-p${String(pageNo).padStart(2, "0")}.md`);
  const normalizedSummary = String(summaryText ?? "").trim();
  fs.writeFileSync(partSummaryPath, normalizedSummary ? `${normalizedSummary}\n` : "", "utf8");
  return partSummaryPath;
}

export function buildPartPromptArtifact({
  pageNo,
  partTitle,
  durationSec,
  subtitleText,
  subtitlePath = null,
  promptProfile = null,
}: {
  pageNo: number;
  partTitle: string;
  durationSec: number;
  subtitleText: string;
  subtitlePath?: string | null;
  promptProfile?: {
    displayName?: string | null;
    preset?: string | null;
    extraRules?: string[] | null;
  } | null;
}) {
  const segments = buildSummarySegmentsFromSrt(subtitleText, durationSec);
  const { systemPrompt, userPrompt } = buildSummaryPromptInput({
    pageNo,
    partTitle,
    durationSec,
    subtitleText,
    segments,
    promptProfile,
  });
  const normalizedSubtitlePath = String(subtitlePath ?? "").trim();
  const normalizedPreset = String(promptProfile?.preset ?? "").trim();
  const normalizedDisplayName = String(promptProfile?.displayName ?? "").trim();

  const lines = [
    `# Prompt P${String(pageNo).padStart(2, "0")}`,
    "",
    `- pageNo: ${pageNo}`,
    `- partTitle: ${String(partTitle ?? "").trim() || `P${pageNo}`}`,
    `- duration: ${formatSummaryTime(durationSec)}`,
    `- segmentCount: ${segments.length}`,
  ];

  if (normalizedSubtitlePath) {
    lines.push(`- subtitlePath: ${normalizedSubtitlePath}`);
  }

  if (normalizedDisplayName) {
    lines.push(`- promptProfile: ${normalizedDisplayName}`);
  }

  if (normalizedPreset) {
    lines.push(`- promptPreset: ${normalizedPreset}`);
  }

  lines.push(
    "",
    "## System Prompt",
    "",
    "```text",
    systemPrompt,
    "```",
    "",
    "## User Prompt",
    "",
    "```json",
    userPrompt,
    "```",
  );

  return lines.join("\n").trimEnd() + "\n";
}

export function writePartPromptArtifact({
  db = null,
  video,
  pageNo,
  partTitle,
  durationSec,
  subtitleText = null,
  subtitlePath = null,
  promptProfile = null,
  promptConfigPath,
  ownerMid = null,
  workRoot = "work",
}: {
  db?: Db | null;
  video: Pick<VideoRecord, "id" | "bvid" | "title"> & Partial<Pick<VideoRecord, "owner_mid" | "owner_name" | "owner_dir_name" | "work_dir_name">>;
  pageNo: number;
  partTitle: string;
  durationSec: number;
  subtitleText?: string | null;
  subtitlePath?: string | null;
  promptProfile?: {
    displayName?: string | null;
    preset?: string | null;
    extraRules?: string[] | null;
  } | null;
  promptConfigPath?: string | null;
  ownerMid?: number | null;
  workRoot?: string;
}): string | null {
  const normalizedSubtitleText = typeof subtitleText === "string"
    ? subtitleText
    : readPromptSubtitleText(subtitlePath);
  if (!normalizedSubtitleText.trim()) {
    return null;
  }

  const workDir = ensureVideoWorkDir({
    db,
    video,
    workRoot,
  });
  const resolvedPromptProfile = promptProfile ?? resolveSummaryPromptProfile({
    ownerMid: ownerMid ?? video.owner_mid ?? null,
    promptConfigPath,
  });
  const partPromptPath = path.join(workDir, `prompt-p${String(pageNo).padStart(2, "0")}.md`);
  const promptArtifact = buildPartPromptArtifact({
    pageNo,
    partTitle,
    durationSec,
    subtitleText: normalizedSubtitleText,
    subtitlePath,
    promptProfile: resolvedPromptProfile,
  });

  fs.writeFileSync(partPromptPath, promptArtifact, "utf8");
  return partPromptPath;
}

export function writeSummaryArtifacts(
  db: Db,
  video: VideoRecord,
  workRoot = "work",
  options: {
    promptConfigPath?: string | null;
  } = {},
): SummaryArtifacts {
  const workDir = ensureVideoWorkDir({
    db,
    video,
    workRoot,
  });
  const activeParts = listVideoParts(db, video.id);

  const allSummaryText = activeParts
    .map((part) => getAlignedSummaryText(part))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const pendingSourceParts = Number(video.publish_needs_rebuild)
    ? activeParts.filter((part) => getAlignedSummaryText(part))
    : listPendingPublishParts(db, video.id);

  const pendingSummaryText = pendingSourceParts
    .map((part) => getAlignedSummaryText(part))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const summaryPath = path.join(workDir, "summary.md");
  const pendingPath = path.join(workDir, "pending-summary.md");

  fs.writeFileSync(summaryPath, allSummaryText ? `${allSummaryText}\n` : "", "utf8");
  fs.writeFileSync(pendingPath, pendingSummaryText ? `${pendingSummaryText}\n` : "", "utf8");
  rewritePerPageSummaryViews(workDir, activeParts);

  const shouldRewritePrompts = Object.prototype.hasOwnProperty.call(options, "promptConfigPath");
  if (shouldRewritePrompts) {
    rewritePerPagePromptViews(workDir, activeParts, {
      db,
      video,
      workRoot,
      promptConfigPath: options.promptConfigPath,
    });
  } else {
    cleanupPerPageArtifacts(workDir, activeParts, /^prompt-p\d+\.md$/u, (part) => `prompt-p${String(part.page_no).padStart(2, "0")}.md`);
  }

  return {
    summaryPath,
    pendingSummaryPath: pendingPath,
  };
}

function rewritePerPageSummaryViews(workDir: string, parts: VideoPartRecord[]) {
  for (const part of parts) {
    const fileName = `summary-p${String(part.page_no).padStart(2, "0")}.md`;
    const filePath = path.join(workDir, fileName);
    const normalizedSummary = getAlignedSummaryText(part);
    fs.writeFileSync(filePath, normalizedSummary ? `${normalizedSummary}\n` : "", "utf8");
  }

  cleanupPerPageArtifacts(workDir, parts, /^summary-p\d+\.md$/u, (part) => `summary-p${String(part.page_no).padStart(2, "0")}.md`);
}

function rewritePerPagePromptViews(
  workDir: string,
  parts: VideoPartRecord[],
  {
    db,
    video,
    workRoot,
    promptConfigPath,
  }: {
    db: Db;
    video: VideoRecord;
    workRoot: string;
    promptConfigPath?: string | null;
  },
) {
  for (const part of parts) {
    writePartPromptArtifact({
      db,
      video,
      pageNo: part.page_no,
      partTitle: part.part_title,
      durationSec: part.duration_sec,
      subtitlePath: part.subtitle_path,
      promptConfigPath,
      ownerMid: video.owner_mid,
      workRoot,
    });
  }

  cleanupPerPageArtifacts(workDir, parts, /^prompt-p\d+\.md$/u, (part) => `prompt-p${String(part.page_no).padStart(2, "0")}.md`);
}

function cleanupPerPageArtifacts(
  workDir: string,
  parts: VideoPartRecord[],
  pattern: RegExp,
  getFileName: (part: VideoPartRecord) => string,
) {
  const currentFileNames = new Set(parts.map((part) => getFileName(part)));

  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    if (!pattern.test(entry.name)) {
      continue;
    }

    if (currentFileNames.has(entry.name)) {
      continue;
    }

    fs.rmSync(path.join(workDir, entry.name), { force: true });
  }
}

function readPromptSubtitleText(subtitlePath: string | null | undefined) {
  const normalizedSubtitlePath = String(subtitlePath ?? "").trim();
  if (!normalizedSubtitlePath || !fs.existsSync(normalizedSubtitlePath)) {
    return "";
  }

  return fs.readFileSync(normalizedSubtitlePath, "utf8");
}

function getAlignedSummaryText(part: VideoPartRecord): string {
  return reindexSummaryTextToPage(getPreferredSummaryText(part), part.page_no);
}
