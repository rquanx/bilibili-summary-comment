import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildSummarySegmentsFromSrt } from "../subtitle/srt-utils";
import { savePartSummary } from "../db/index";
import { writePartSummaryArtifact } from "./files";
import { requestSummary } from "./client";
import { normalizeSummaryOutput } from "./output";
import { resolveSummaryPromptProfile } from "./prompt-config";

export async function summarizePartFromSubtitle({
  db,
  videoId,
  bvid,
  pageNo,
  cid = null,
  partTitle,
  durationSec,
  subtitlePath,
  model,
  apiKey,
  apiBaseUrl,
  apiFormat,
  promptConfigPath = null,
  ownerMid = null,
  ownerName = null,
  workRoot = "work",
  eventLogger = null,
}) {
  if (!apiKey) {
    throw new Error("Missing summary API key. Set SUMMARY_API_KEY or OPENAI_API_KEY.");
  }

  eventLogger?.log({
    scope: "summary",
    action: "llm",
    status: "started",
    pageNo,
    cid,
    partTitle,
    message: `Starting LLM summary for P${pageNo}`,
    details: {
      model,
      apiFormat,
      subtitlePath,
    },
  });

  try {
    const subtitleText = fs.readFileSync(subtitlePath, "utf8");
    const segments = buildSummarySegmentsFromSrt(subtitleText, durationSec);
    const promptProfile = resolveSummaryPromptProfile({
      ownerMid,
      promptConfigPath,
    });
    const pageSummary = await requestSummary({
      pageNo,
      partTitle,
      durationSec,
      subtitleText,
      segments,
      promptProfile,
      model,
      apiKey,
      apiBaseUrl,
      apiFormat,
    });

    const normalizedSummary = normalizeSummaryOutput(pageSummary, pageNo, {
      subtitleText,
    });
    const normalized = `${normalizedSummary}\n`;
    const summaryHash = createHash("sha1").update(normalized).digest("hex");
    const saved = savePartSummary(db, videoId, pageNo, {
      summaryText: normalized.trim(),
      summaryHash,
    });

    const partSummaryPath = writePartSummaryArtifact({
      bvid,
      pageNo,
      summaryText: normalized.trim(),
      workRoot,
    });

    eventLogger?.log({
      scope: "summary",
      action: "llm",
      status: "succeeded",
      pageNo,
      cid,
      partTitle,
      message: `LLM summary ready for P${pageNo}`,
      details: {
        model,
        segmentCount: segments.length,
        summaryHash,
        summaryPath: partSummaryPath,
        summaryPromptOwnerMid: promptProfile.ownerMid,
        summaryPromptOwnerName: ownerName,
        summaryPromptPreset: promptProfile.preset ?? null,
        summaryPromptExtraRuleCount: promptProfile.extraRules.length,
      },
    });

    return {
      pageNo,
      summaryText: normalized.trim(),
      summaryHash,
      summaryPath: partSummaryPath,
      dbRow: saved,
    };
  } catch (error) {
    eventLogger?.log({
      scope: "summary",
      action: "llm",
      status: "failed",
      pageNo,
      cid,
      partTitle,
      message: error?.message ?? "Unknown summary error",
      details: {
        model,
        subtitlePath,
      },
    });
    throw error;
  }
}
