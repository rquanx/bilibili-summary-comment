import { findReusableSummarySource, reusePartSummaries } from "./live-session-reuse.mjs";
import { writePartSummaryArtifact, writeSummaryArtifacts } from "./summary-files.mjs";
import { ensureSubtitleForPart } from "./subtitle-pipeline.mjs";
import { summarizePartFromSubtitle } from "./summarizer.mjs";
import { listVideoParts } from "./storage.mjs";

export async function runGenerationStage({
  client,
  db,
  video,
  cookie,
  cookieFile = null,
  workRoot = "work",
  venvPath = ".3.11",
  asr = "faster-whisper",
  summaryConfig,
  forceSummary = false,
  eventLogger = null,
  progress,
}) {
  let currentParts = listVideoParts(db, video.id);
  let reusedSummarySource = null;
  const hasPendingSummaries = currentParts.some((part) => !String(part.summary_text ?? "").trim());

  if (!forceSummary && hasPendingSummaries) {
    reusedSummarySource = findReusableSummarySource(db, video, currentParts);
    if (reusedSummarySource) {
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
            bvid: video.bvid,
            pageNo: part.page_no,
            summaryText: part.summary_text,
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
    progress?.log(
      `Reused ${reusedSummarySource.reusedPages.length} summaries from ${reusedSummarySource.video.bvid} (${reusedSummarySource.video.title})`,
    );
  }
  if (targetParts.length === 0) {
    eventLogger?.log({
      scope: "pipeline",
      action: "generation",
      status: "skipped",
      message: "All parts already have summaries",
    });
    progress?.log("All parts already have summaries, skipping subtitle and summary generation");
  }

  const subtitleResults = [];
  const summaryResults = [];

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

    const subtitleResult = await ensureSubtitleForPart({
      client,
      db,
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
    progress?.logPart(currentIndex, part, "Subtitle ready", describeSubtitleResult(subtitleResult));
    subtitleResults.push({
      pageNo: part.page_no,
      subtitlePath: subtitleResult.subtitlePath,
      subtitleSource: subtitleResult.subtitleSource,
      reused: subtitleResult.reused,
    });

    progress?.logPart(currentIndex, part, "Generating summary", `model ${summaryConfig.model}`);
    const summaryResult = await summarizePartFromSubtitle({
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
      workRoot,
      cid: part.cid,
      eventLogger,
    });
    progress?.logPart(currentIndex, part, "Summary ready", summaryResult.summaryPath);
    summaryResults.push({
      pageNo: part.page_no,
      summaryPath: summaryResult.summaryPath,
      summaryHash: summaryResult.summaryHash,
    });
  }

  progress?.log("Writing summary artifacts");
  const artifacts = writeSummaryArtifacts(db, video, workRoot);
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

  return {
    currentParts,
    targetParts,
    reusedSummarySource,
    subtitleResults,
    summaryResults,
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
