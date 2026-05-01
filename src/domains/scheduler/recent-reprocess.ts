import {
  getVideoByIdentity,
  listAllVideoParts,
  markVideoPublishRebuildNeeded,
  resetPublishedStateForVideo,
  savePartProcessedSummary,
  updateVideoCommentThread,
} from "../../infra/db/index";
import type { Db, VideoPartRecord, VideoRecord } from "../../infra/db/index";
import type { RecentUpload } from "./uploads";

const PASTE_RS_URL_PATTERN = /https:\/\/paste\.rs\/\S+/u;

export interface RecentReprocessCandidate extends RecentUpload {
  videoId: number | null;
  hadStoredVideo: boolean;
  reasons: RecentReprocessReason[];
  pastePages: number[];
}

export type RecentReprocessReason =
  | "missing-comment-thread"
  | "paste-rs-processed-summary"
  | "publish-rebuild-needed";

export interface RecentReprocessPreparationResult {
  videoId: number | null;
  clearedProcessedPages: number[];
  resetPublishedState: boolean;
  markedPublishRebuild: boolean;
}

export function collectRecentReprocessCandidates(
  db: Db,
  uploads: RecentUpload[],
): RecentReprocessCandidate[] {
  return uploads.flatMap((upload) => {
    const video = getVideoByIdentity(db, {
      bvid: upload.bvid,
      aid: upload.aid ?? null,
    });
    const parts = video ? listAllVideoParts(db, video.id) : [];
    const candidate = buildRecentReprocessCandidate(upload, video, parts);
    return candidate ? [candidate] : [];
  });
}

export function buildRecentReprocessCandidate(
  upload: RecentUpload,
  video: Pick<VideoRecord, "id" | "root_comment_rpid" | "publish_needs_rebuild"> | null,
  parts: Array<Pick<VideoPartRecord, "page_no" | "summary_text_processed">>,
): RecentReprocessCandidate | null {
  const pastePages = collectPasteRsPages(parts);
  const reasons = new Set<RecentReprocessReason>();

  if (!video || Number(video.root_comment_rpid ?? 0) <= 0) {
    reasons.add("missing-comment-thread");
  }

  if (pastePages.length > 0) {
    reasons.add("paste-rs-processed-summary");
  }

  if (Number(video?.publish_needs_rebuild ?? 0) === 1) {
    reasons.add("publish-rebuild-needed");
  }

  if (reasons.size === 0) {
    return null;
  }

  return {
    ...upload,
    videoId: video?.id ?? null,
    hadStoredVideo: Boolean(video),
    reasons: [...reasons],
    pastePages,
  };
}

export function prepareRecentReprocessCandidate(
  db: Db,
  candidate: RecentReprocessCandidate,
): RecentReprocessPreparationResult {
  if (!candidate.videoId) {
    return {
      videoId: null,
      clearedProcessedPages: [],
      resetPublishedState: false,
      markedPublishRebuild: false,
    };
  }

  const clearedProcessedPages: number[] = [];
  if (candidate.reasons.includes("paste-rs-processed-summary")) {
    for (const pageNo of candidate.pastePages) {
      savePartProcessedSummary(db, candidate.videoId, pageNo, null);
      clearedProcessedPages.push(pageNo);
    }

    markVideoPublishRebuildNeeded(db, candidate.videoId, "recent-reprocess-paste-rs");
  }

  let resetPublishedState = false;
  if (candidate.reasons.includes("missing-comment-thread")) {
    resetPublishedStateForVideo(db, candidate.videoId);
    updateVideoCommentThread(db, candidate.videoId, {
      rootCommentRpid: null,
      topCommentRpid: null,
    });
    resetPublishedState = true;
  }

  return {
    videoId: candidate.videoId,
    clearedProcessedPages,
    resetPublishedState,
    markedPublishRebuild:
      candidate.reasons.includes("paste-rs-processed-summary")
      || candidate.reasons.includes("publish-rebuild-needed"),
  };
}

export function formatRecentReprocessReason(reason: RecentReprocessReason): string {
  switch (reason) {
    case "missing-comment-thread":
      return "missing-comment-thread";
    case "paste-rs-processed-summary":
      return "paste-rs";
    case "publish-rebuild-needed":
      return "publish-rebuild-needed";
    default:
      return reason;
  }
}

function collectPasteRsPages(parts: Array<Pick<VideoPartRecord, "page_no" | "summary_text_processed">>): number[] {
  return parts
    .filter((part) => PASTE_RS_URL_PATTERN.test(String(part.summary_text_processed ?? "").trim()))
    .map((part) => Number(part.page_no))
    .filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0)
    .sort((left, right) => left - right);
}
