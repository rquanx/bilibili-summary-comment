import {
  clearVideoPublishRebuildNeeded,
  getVideoByIdentity,
  listAllVideoParts,
  listPendingPublishParts,
  listPendingSummaryParts,
  listVideoParts,
  listVideos,
  markVideoPublishRebuildNeeded,
  runInTransaction,
  upsertVideo,
  upsertVideoPart,
} from "../../infra/db/index";
import type { Db, VideoIdentity, VideoPartRecord, VideoSnapshot, VideoState } from "../../infra/db/index";
import { buildOwnerDirName, buildVideoWorkDirName } from "../../shared/work-paths";
import { createSummaryHash, detectSnapshotChanges, reindexSummaryText } from "./change-detection";

export function syncVideoSnapshotToDb(db: Db, snapshot: VideoSnapshot): VideoState {
  const existingVideo = getVideoByIdentity(db, { bvid: snapshot.bvid, aid: snapshot.aid });
  const previousParts = existingVideo ? listAllVideoParts(db, existingVideo.id) : [];
  const previousActiveParts = previousParts
    .filter((part) => !part.is_deleted)
    .sort((left, right) => left.page_no - right.page_no);
  const previousPartsByCid = new Map<number, VideoPartRecord>(previousParts.map((part) => [part.cid, part]));
  const nextPages = [...snapshot.pages].sort((left, right) => left.pageNo - right.pageNo);
  const nextCidSet = new Set(nextPages.map((page) => page.cid));
  const knownVideos = listVideos(db);
  const ownerDirName = buildOwnerDirName({
    ownerName: snapshot.ownerName ?? existingVideo?.owner_name ?? null,
    ownerMid: snapshot.ownerMid ?? existingVideo?.owner_mid ?? null,
    existingOwnerDirName: existingVideo?.owner_dir_name ?? null,
    existingVideos: knownVideos,
    currentVideoId: existingVideo?.id ?? null,
  });
  const workDirName = buildVideoWorkDirName({
    title: snapshot.title,
    bvid: snapshot.bvid,
    ownerName: snapshot.ownerName ?? existingVideo?.owner_name ?? null,
    existingWorkDirName: existingVideo?.work_dir_name ?? null,
  });

  const changeSet = detectSnapshotChanges(previousActiveParts, nextPages);
  const hadPublishedThread =
    Boolean(existingVideo?.root_comment_rpid) ||
    previousParts.some((part) => Boolean(part.published) || part.published_comment_rpid !== null);
  let videoId = existingVideo?.id ?? null;

  runInTransaction(db, () => {
    const video = upsertVideo(db, {
      ...snapshot,
      ownerDirName,
      workDirName,
    });
    videoId = video.id;

    for (const page of nextPages) {
      const existingPart = previousPartsByCid.get(page.cid);
      const moved = existingPart && Number(existingPart.page_no) !== page.pageNo;
      const normalizedSummaryText =
        moved && String(existingPart?.summary_text ?? "").trim()
          ? reindexSummaryText(existingPart.summary_text, page.pageNo)
          : existingPart?.summary_text ?? null;
      const normalizedProcessedSummaryText =
        moved && String(existingPart?.summary_text_processed ?? "").trim()
          ? reindexSummaryText(existingPart.summary_text_processed, page.pageNo)
          : existingPart?.summary_text_processed ?? null;
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
        subtitleText: existingPart?.subtitle_text ?? null,
        promptText: existingPart?.prompt_text ?? null,
        summaryText: normalizedSummaryText,
        processedSummaryText: normalizedProcessedSummaryText,
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
        subtitleText: part.subtitle_text ?? null,
        promptText: part.prompt_text ?? null,
        summaryText: part.summary_text ?? null,
        processedSummaryText: part.summary_text_processed ?? null,
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
  });

  if (!videoId) {
    throw new Error(`Failed to sync video snapshot for ${snapshot.bvid}`);
  }

  const refreshedVideo = getVideoByIdentity(db, { bvid: snapshot.bvid, aid: snapshot.aid });
  if (!refreshedVideo) {
    throw new Error(`Failed to load synced video state for ${snapshot.bvid}`);
  }

  const parts = listVideoParts(db, videoId);
  return {
    video: refreshedVideo,
    parts,
    pendingSummaryParts: listPendingSummaryParts(db, videoId),
    pendingPublishParts: listPendingPublishParts(db, videoId),
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
