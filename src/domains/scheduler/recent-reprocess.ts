import {
  getVideoByIdentity,
  listAllVideoParts,
  markVideoPublishRebuildNeeded,
  resetPublishedStateForVideo,
  savePartProcessedSummary,
  updateVideoCommentThread,
} from "../../infra/db/index";
import type { Db, VideoPartRecord, VideoRecord } from "../../infra/db/index";
import {
  inspectVisibleGuestSummaryThread,
  type VisibleGuestSummaryThreadInspection,
} from "../bili/comment-thread";
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

export interface RecentReprocessCandidateFingerprintInput {
  bvid: string;
  reasons: string[];
  pastePages: number[];
}

export async function collectRecentReprocessCandidates(
  db: Db,
  uploads: RecentUpload[],
  {
    inspectVisibleThreadImpl = inspectVisibleGuestSummaryThread,
  }: {
    inspectVisibleThreadImpl?: (options: {
      oid: number;
      type: number;
      expectedRootRpid?: number | null;
    }) => Promise<VisibleGuestSummaryThreadInspection>;
  } = {},
): Promise<RecentReprocessCandidate[]> {
  const candidates: RecentReprocessCandidate[] = [];

  for (const upload of uploads) {
    const video = getVideoByIdentity(db, {
      bvid: upload.bvid,
      aid: upload.aid ?? null,
    });
    const parts = video ? listAllVideoParts(db, video.id) : [];
    const liveThread = await inspectLiveSummaryThread({
      upload,
      video,
      inspectVisibleThreadImpl,
    });
    const candidate = buildRecentReprocessCandidate(upload, video, parts, liveThread);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function buildRecentReprocessCandidate(
  upload: RecentUpload,
  video: Pick<VideoRecord, "id" | "root_comment_rpid" | "publish_needs_rebuild"> | null,
  parts: Array<Pick<VideoPartRecord, "page_no" | "summary_text_processed">>,
  liveThread: Pick<VisibleGuestSummaryThreadInspection, "hasTopComment" | "topCommentRpid" | "pastePages"> | null = null,
): RecentReprocessCandidate | null {
  const pastePages = collectCombinedPasteRsPages(parts, liveThread?.pastePages ?? []);
  const reasons = new Set<RecentReprocessReason>();
  const storedRootCommentRpid = Number(video?.root_comment_rpid ?? 0);

  if (!video || storedRootCommentRpid <= 0) {
    reasons.add("missing-comment-thread");
  } else if (
    liveThread
    && (
      !liveThread.hasTopComment
      || Number(liveThread.topCommentRpid ?? 0) !== storedRootCommentRpid
    )
  ) {
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

export function buildRecentReprocessCandidateKey({
  bvid,
  reasons,
  pastePages,
}: RecentReprocessCandidateFingerprintInput): string {
  const normalizedBvid = String(bvid ?? "").trim();
  const normalizedReasons = [...new Set(
    (Array.isArray(reasons) ? reasons : [])
      .map((reason) => String(reason ?? "").trim())
      .filter(Boolean),
  )].sort();
  const normalizedPastePages = [...new Set(
    (Array.isArray(pastePages) ? pastePages : [])
      .map((pageNo) => Number(pageNo))
      .filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0),
  )].sort((left, right) => left - right);

  return JSON.stringify({
    bvid: normalizedBvid,
    reasons: normalizedReasons,
    pastePages: normalizedPastePages,
  });
}

function collectPasteRsPages(parts: Array<Pick<VideoPartRecord, "page_no" | "summary_text_processed">>): number[] {
  return parts
    .filter((part) => PASTE_RS_URL_PATTERN.test(String(part.summary_text_processed ?? "").trim()))
    .map((part) => Number(part.page_no))
    .filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0)
    .sort((left, right) => left - right);
}

function collectCombinedPasteRsPages(
  parts: Array<Pick<VideoPartRecord, "page_no" | "summary_text_processed">>,
  livePastePages: number[],
): number[] {
  return [...new Set([
    ...collectPasteRsPages(parts),
    ...(Array.isArray(livePastePages) ? livePastePages : []),
  ].map((pageNo) => Number(pageNo)).filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0))].sort((left, right) => left - right);
}

async function inspectLiveSummaryThread({
  upload,
  video,
  inspectVisibleThreadImpl,
}: {
  upload: RecentUpload;
  video: Pick<VideoRecord, "root_comment_rpid"> | null;
  inspectVisibleThreadImpl: (options: {
    oid: number;
    type: number;
    expectedRootRpid?: number | null;
  }) => Promise<VisibleGuestSummaryThreadInspection>;
}) {
  const storedRootCommentRpid = Number(video?.root_comment_rpid ?? 0);
  const oid = Number(upload.aid ?? 0);
  if (storedRootCommentRpid <= 0 || !Number.isInteger(oid) || oid <= 0) {
    return null;
  }

  return inspectVisibleThreadImpl({
    oid,
    type: 1,
    expectedRootRpid: storedRootCommentRpid,
  });
}
