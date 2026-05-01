import { findReusableSummarySource, reusePartSummaries } from "../summary/live-session-reuse";
import { writePartPromptArtifact, writePartSummaryArtifact, writeSummaryArtifacts } from "../summary/files";
import { ensureSubtitleForPart } from "../subtitle/pipeline";
import { summarizePartFromSubtitle } from "../summary/index";
import { shouldSkipSummaryPart } from "../summary/service";
import { attachErrorDetails } from "../cli/errors";
import { listVideoParts } from "../db/index";
import { formatBlockingErrorDetail } from "./progress";

export async function runGenerationStage({
  client,
  db,
  video,
  summaryOwnerMid = null,
  summaryOwnerName = null,
  cookie,
  cookieFile = null,
  workRoot = "work",
  venvPath = ".3.11",
  asr = "faster-whisper",
  summaryConfig,
  forceSummary = false,
  eventLogger = null,
  progress,
  ensureSubtitleForPartImpl = ensureSubtitleForPart,
  summarizePartFromSubtitleImpl = summarizePartFromSubtitle,
  writeSummaryArtifactsImpl = writeSummaryArtifacts,
}) {
  let currentParts = listVideoParts(db, video.id);
  let reusedSummarySource = null;
  let reuseCandidateVideo = null;
  const hasPendingSummaries = currentParts.some((part) => !String(part.summary_text ?? "").trim());
  let reuseLookupAttempted = false;
  let reuseLookupMatchedSource = false;

  if (!forceSummary && hasPendingSummaries) {
    reuseLookupAttempted = true;
    reusedSummarySource = findReusableSummarySource(db, video, currentParts);
    if (reusedSummarySource) {
      reuseLookupMatchedSource = true;
      reuseCandidateVideo = reusedSummarySource.video;
      const reusedPages = reusePartSummaries(db, video.id, reusedSummarySource.parts);
      currentParts = listVideoParts(db, video.id);
      if (reusedPages.length > 0) {
        reusedSummarySource = {
          ...reusedSummarySource,
          reusedPages,
        };

        for (const part of currentParts) {
          if (!reusedPages.includes(part.page_no)) {
            continue;
          }

          writePartSummaryArtifact({
            db,
            video,
            pageNo: part.page_no,
            summaryText: part.summary_text,
            workRoot,
          });
          writePartPromptArtifact({
            db,
            video,
            pageNo: part.page_no,
            partTitle: part.part_title,
            durationSec: part.duration_sec,
            subtitlePath: part.subtitle_path,
            promptConfigPath: summaryConfig.promptConfigPath,
            promptConfigContent: summaryConfig.promptConfigContent,
            ownerMid: summaryOwnerMid,
            workRoot,
          });
        }
      } else {
        reusedSummarySource = null;
      }
    }
  }

  const targetParts = currentParts.filter((part) => forceSummary || !String(part.summary_text ?? "").trim());
  if (reusedSummarySource) {
    eventLogger?.log({
      scope: "summary",
      action: "reuse",
      status: "succeeded",
      message: `Reused summaries from ${reusedSummarySource.video.bvid}`,
      details: {
        sourceBvid: reusedSummarySource.video.bvid,
        sourceTitle: reusedSummarySource.video.title,
        reusedPages: reusedSummarySource.reusedPages,
      },
    });
    progress?.success(
      `Reused ${reusedSummarySource.reusedPages.length} summaries from ${reusedSummarySource.video.bvid} (${reusedSummarySource.video.title})`,
    );
  } else if (reuseLookupAttempted) {
    const reuseSkippedMessage = reuseLookupMatchedSource
      ? "Found same-session summary source but no pending pages matched for reuse"
      : "No reusable same-session summary source found";
    eventLogger?.log({
      scope: "summary",
      action: "reuse",
      status: "skipped",
      message: reuseSkippedMessage,
      details: reuseLookupMatchedSource
        ? {
            sourceBvid: reuseCandidateVideo?.bvid ?? null,
            sourceTitle: reuseCandidateVideo?.title ?? null,
          }
        : {
            pendingParts: currentParts.filter((part) => !String(part.summary_text ?? "").trim()).map((part) => part.page_no),
          },
    });
  }
  if (targetParts.length === 0) {
    eventLogger?.log({
      scope: "pipeline",
      action: "generation",
      status: "skipped",
      message: "All parts already have summaries",
    });
    progress?.warn("All parts already have summaries, skipping subtitle and summary generation");
  }

  const subtitleResults = [];
  const summaryResults = [];
  const skippedSummaryResults = [];

  for (const [index, part] of targetParts.entries()) {
    const currentIndex = index + 1;
    eventLogger?.log({
      scope: "pipeline",
      action: "part",
      status: "started",
      pageNo: part.page_no,
      cid: part.cid,
      partTitle: part.part_title,
      message: `Starting work for P${part.page_no}`,
      details: {
        index: currentIndex,
        totalPendingParts: targetParts.length,
      },
    });
    progress?.logPart(currentIndex, part, "Started");

    let subtitleResult;
    try {
      subtitleResult = await ensureSubtitleForPartImpl({
        client,
        db,
        video,
        videoId: video.id,
        bvid: video.bvid,
        videoTitle: video.title,
        pageNo: part.page_no,
        cid: part.cid,
        partTitle: part.part_title,
        existingSubtitlePath: part.subtitle_path ?? null,
        cookie,
        cookieFile,
        durationSec: part.duration_sec,
        workRoot,
        venvPath,
        asr,
        progress,
        eventLogger,
      });
    } catch (error) {
      progress?.logPart(currentIndex, part, "Failed", `Subtitle step blocked: ${formatBlockingErrorDetail(error)}`);
      attachErrorDetails(error, {
        bvid: video.bvid,
        failedStep: "subtitle",
        failedScope: "subtitle",
        failedAction: "ensure",
        pageNo: part.page_no,
        cid: part.cid,
        partTitle: part.part_title,
      });
      throw error;
    }
    progress?.logPart(currentIndex, part, "Subtitle ready", describeSubtitleResult(subtitleResult));
    subtitleResults.push({
      pageNo: part.page_no,
      subtitlePath: subtitleResult.subtitlePath,
      subtitleSource: subtitleResult.subtitleSource,
      reused: subtitleResult.reused,
    });

    progress?.logPart(currentIndex, part, "Generating summary", `model ${summaryConfig.model}`);
    let summaryResult;
    try {
      summaryResult = await summarizePartFromSubtitleImpl({
        db,
        videoId: video.id,
        bvid: video.bvid,
        pageNo: part.page_no,
        partTitle: part.part_title,
        durationSec: part.duration_sec,
        subtitlePath: subtitleResult.subtitlePath,
        model: summaryConfig.model,
        apiKey: summaryConfig.apiKey,
        apiBaseUrl: summaryConfig.apiBaseUrl,
        apiFormat: summaryConfig.apiFormat,
        promptConfigPath: summaryConfig.promptConfigPath,
        promptConfigContent: summaryConfig.promptConfigContent,
        ownerMid: summaryOwnerMid,
        ownerName: summaryOwnerName,
        workRoot,
        cid: part.cid,
        eventLogger,
      });
    } catch (error) {
      if (shouldSkipSummaryPart({ error })) {
        const skippedDetail = formatBlockingErrorDetail(error);
        progress?.logPart(currentIndex, part, "Summary skipped", skippedDetail);
        eventLogger?.log({
          scope: "summary",
          action: "skip",
          status: "skipped",
          pageNo: part.page_no,
          cid: part.cid,
          partTitle: part.part_title,
          message: `Skipped summary for P${part.page_no} due to provider content filter`,
          details: {
            reason: "content-filter-high-risk",
            model: summaryConfig.model,
            error: skippedDetail,
          },
        });
        skippedSummaryResults.push({
          pageNo: part.page_no,
          cid: part.cid,
          partTitle: part.part_title,
          reason: "content-filter-high-risk",
          message: skippedDetail,
        });
        continue;
      }

      progress?.logPart(currentIndex, part, "Failed", `Summary step blocked: ${formatBlockingErrorDetail(error)}`);
      attachErrorDetails(error, {
        bvid: video.bvid,
        failedStep: "summary",
        failedScope: "summary",
        failedAction: "generate",
        pageNo: part.page_no,
        cid: part.cid,
        partTitle: part.part_title,
      });
      throw error;
    }
    progress?.logPart(currentIndex, part, "Summary ready", summaryResult.summaryPath);
    summaryResults.push({
      pageNo: part.page_no,
      summaryPath: summaryResult.summaryPath,
      summaryHash: summaryResult.summaryHash,
    });
  }

  progress?.info("Writing summary artifacts");
  let artifacts;
  try {
    artifacts = writeSummaryArtifactsImpl(db, video, workRoot, {
      promptConfigPath: summaryConfig.promptConfigPath,
      promptConfigContent: summaryConfig.promptConfigContent,
    });
  } catch (error) {
    progress?.error(`Artifact write blocked: ${formatBlockingErrorDetail(error)}`);
    attachErrorDetails(error, {
      bvid: video.bvid,
      failedStep: "artifacts",
      failedScope: "pipeline",
      failedAction: "artifacts",
    });
    throw error;
  }
  eventLogger?.log({
    scope: "pipeline",
    action: "artifacts",
    status: "succeeded",
    message: "Summary artifacts written",
    details: {
      summaryPath: artifacts.summaryPath,
      pendingSummaryPath: artifacts.pendingSummaryPath,
    },
  });
  if (skippedSummaryResults.length > 0) {
    progress?.warn(
      `Skipped ${skippedSummaryResults.length} summary part${skippedSummaryResults.length > 1 ? "s" : ""} due to provider content filter`,
    );
  }

  return {
    currentParts: listVideoParts(db, video.id),
    targetParts,
    reusedSummarySource,
    subtitleResults,
    summaryResults,
    skippedSummaryResults,
    artifacts,
  };
}

function describeSubtitleResult(result) {
  if (result.reused) {
    return "Using local subtitle";
  }

  if (result.subtitleSource === "bili_ai") {
    return "Using Bilibili AI subtitle";
  }

  if (result.subtitleSource === "bili_subtitle") {
    return "Using Bilibili subtitle";
  }

  return "Using ASR transcription";
}
