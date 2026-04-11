import {
  clearVideoPublishRebuildNeeded,
  getVideoByIdentity,
  listAllVideoParts,
  listPendingPublishParts,
  listPendingSummaryParts,
  listVideoParts,
  markVideoPublishRebuildNeeded,
  upsertVideo,
  upsertVideoPart,
} from "../db/index";
import type { Db, VideoIdentity, VideoPartRecord, VideoSnapshot, VideoState } from "../db/index";
import { createSummaryHash, detectSnapshotChanges, reindexSummaryText } from "./change-detection";

export function syncVideoSnapshotToDb(db: Db, snapshot: VideoSnapshot): VideoState {
  const video = upsertVideo(db, snapshot);
  const previousParts = listAllVideoParts(db, video.id);
  const previousActiveParts = previousParts
    .filter((part) => !part.is_deleted)
    .sort((left, right) => left.page_no - right.page_no);
  const previousPartsByCid = new Map<number, VideoPartRecord>(previousParts.map((part) => [part.cid, part]));
  const nextPages = [...snapshot.pages].sort((left, right) => left.pageNo - right.pageNo);
  const nextCidSet = new Set(nextPages.map((page) => page.cid));

  const changeSet = detectSnapshotChanges(previousActiveParts, nextPages);
  const hadPublishedThread =
    Boolean(video.root_comment_rpid) ||
    previousParts.some((part) => Boolean(part.published) || part.published_comment_rpid !== null);

  for (const page of nextPages) {
    const existingPart = previousPartsByCid.get(page.cid);
    const moved = existingPart && Number(existingPart.page_no) !== page.pageNo;
    const normalizedSummaryText =
      moved && String(existingPart?.summary_text ?? "").trim()
        ? reindexSummaryText(existingPart.summary_text, page.pageNo)
        : existingPart?.summary_text ?? null;
    const normalizedSummaryHash =
      normalizedSummaryText && normalizedSummaryText !== existingPart?.summary_text
        ? createSummaryHash(normalizedSummaryText)
        : existingPart?.summary_hash ?? null;
    const preservedPublished = moved ? false : Boolean(existingPart?.published);
    const preservedPublishedCommentRpid = moved ? null : existingPart?.published_comment_rpid ?? null;
    const preservedPublishedAt = moved ? null : existingPart?.published_at ?? null;

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: page.pageNo,
      cid: page.cid,
      partTitle: page.partTitle,
      durationSec: page.durationSec,
      subtitlePath: existingPart?.subtitle_path ?? null,
      subtitleSource: existingPart?.subtitle_source ?? null,
      subtitleLang: existingPart?.subtitle_lang ?? null,
      summaryText: normalizedSummaryText,
      summaryHash: normalizedSummaryHash,
      published: preservedPublished,
      publishedCommentRpid: preservedPublishedCommentRpid,
      publishedAt: preservedPublishedAt,
      isDeleted: false,
      deletedAt: null,
    });
  }

  for (const part of previousParts) {
    if (nextCidSet.has(part.cid)) {
      continue;
    }

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: Number(part.page_no ?? 0),
      cid: part.cid,
      partTitle: part.part_title,
      durationSec: part.duration_sec,
      subtitlePath: part.subtitle_path ?? null,
      subtitleSource: part.subtitle_source ?? null,
      subtitleLang: part.subtitle_lang ?? null,
      summaryText: part.summary_text ?? null,
      summaryHash: part.summary_hash ?? null,
      published: false,
      publishedCommentRpid: null,
      publishedAt: null,
      isDeleted: true,
      deletedAt: new Date().toISOString(),
    });
  }

  if (!Number(video.publish_needs_rebuild) && hadPublishedThread && changeSet.requiresRebuild) {
    markVideoPublishRebuildNeeded(db, video.id, changeSet.rebuildReason);
  }

  if (!hadPublishedThread && Number(video.publish_needs_rebuild)) {
    clearVideoPublishRebuildNeeded(db, video.id);
  }

  const refreshedVideo = getVideoByIdentity(db, { bvid: snapshot.bvid, aid: snapshot.aid });
  const parts = listVideoParts(db, video.id);
  return {
    video: refreshedVideo ?? video,
    parts,
    pendingSummaryParts: listPendingSummaryParts(db, video.id),
    pendingPublishParts: listPendingPublishParts(db, video.id),
    changeSet,
  };
}

export function getVideoStateFromDb(db: Db, identity: VideoIdentity) {
  const video = getVideoByIdentity(db, identity);
  if (!video) {
    return null;
  }

  return {
    video,
    parts: listVideoParts(db, video.id),
    pendingSummaryParts: listPendingSummaryParts(db, video.id),
    pendingPublishParts: listPendingPublishParts(db, video.id),
  };
}
