import {
  getVideoByIdentity,
  isPostgresDatabase,
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

export async function syncVideoSnapshotToDb(db: Db, snapshot: VideoSnapshot): Promise<VideoState> {
  const existingVideo = await getVideoByIdentity(db, { bvid: snapshot.bvid, aid: snapshot.aid });
  const previousParts = existingVideo ? await listAllVideoParts(db, existingVideo.id) : [];
  const previousActiveParts = previousParts
    .filter((part) => !part.is_deleted)
    .sort((left, right) => left.page_no - right.page_no);
  const previousPartsByCid = new Map<number, VideoPartRecord>(previousParts.map((part) => [part.cid, part]));
  const nextPages = [...snapshot.pages].sort((left, right) => left.pageNo - right.pageNo);
  const nextCidSet = new Set(nextPages.map((page) => page.cid));
  const knownVideos = await listVideos(db);
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
  const activePartInputs = nextPages.map((page) => {
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

    return {
      page,
      existingPart,
      normalizedSummaryText,
      normalizedProcessedSummaryText,
      normalizedSummaryHash,
      preservedPublished: moved ? false : Boolean(existingPart?.published),
      preservedPublishedCommentRpid: moved ? null : existingPart?.published_comment_rpid ?? null,
      preservedPublishedAt: moved ? null : existingPart?.published_at ?? null,
    };
  });
  const deletedParts = previousParts.filter((part) => !nextCidSet.has(part.cid));
  let videoId = existingVideo?.id ?? null;

  const videoInput = { ...snapshot, ownerDirName, workDirName };
  if (isPostgresDatabase(db)) {
    await runInTransaction(db, async () => {
      const video = await upsertVideo(db, videoInput);
      videoId = video.id;
      for (const input of activePartInputs) {
        await upsertVideoPart(db, buildActivePartUpsert(video.id, input));
      }
      for (const part of deletedParts) {
        await upsertVideoPart(db, buildDeletedPartUpsert(video.id, part));
      }
      if (!Number(video.publish_needs_rebuild) && hadPublishedThread && changeSet.requiresRebuild) {
        await markVideoPublishRebuildNeeded(db, video.id, changeSet.rebuildReason);
      }
    });
  } else {
    runInTransaction(db, () => {
      const video = upsertVideo(db, videoInput);
      videoId = video.id;
      for (const input of activePartInputs) {
        upsertVideoPart(db, buildActivePartUpsert(video.id, input));
      }
      for (const part of deletedParts) {
        upsertVideoPart(db, buildDeletedPartUpsert(video.id, part));
      }
      if (!Number(video.publish_needs_rebuild) && hadPublishedThread && changeSet.requiresRebuild) {
        markVideoPublishRebuildNeeded(db, video.id, changeSet.rebuildReason);
      }
    });
  }

  if (!videoId) {
    throw new Error(`Failed to sync video snapshot for ${snapshot.bvid}`);
  }

  const refreshedVideo = await getVideoByIdentity(db, { bvid: snapshot.bvid, aid: snapshot.aid });
  if (!refreshedVideo) {
    throw new Error(`Failed to load synced video state for ${snapshot.bvid}`);
  }

  const parts = await listVideoParts(db, videoId);
  return {
    video: refreshedVideo,
    parts,
    pendingSummaryParts: await listPendingSummaryParts(db, videoId),
    pendingPublishParts: await listPendingPublishParts(db, videoId),
    changeSet,
  };
}

function buildActivePartUpsert(videoId: number, input: any) {
  const { page, existingPart } = input;
  return {
    videoId,
    pageNo: page.pageNo,
    cid: page.cid,
    partTitle: page.partTitle,
    durationSec: page.durationSec,
    subtitlePath: existingPart?.subtitle_path ?? null,
    subtitleSource: existingPart?.subtitle_source ?? null,
    subtitleLang: existingPart?.subtitle_lang ?? null,
    sourcePath: existingPart?.source_path ?? null,
    subtitleText: existingPart?.subtitle_text ?? null,
    promptText: existingPart?.prompt_text ?? null,
    summaryText: input.normalizedSummaryText,
    processedSummaryText: input.normalizedProcessedSummaryText,
    summaryHash: input.normalizedSummaryHash,
    published: input.preservedPublished,
    publishedCommentRpid: input.preservedPublishedCommentRpid,
    publishedAt: input.preservedPublishedAt,
    isDeleted: false,
    deletedAt: null,
  };
}

function buildDeletedPartUpsert(videoId: number, part: VideoPartRecord) {
  return {
    videoId,
    pageNo: Number(part.page_no ?? 0),
    cid: part.cid,
    partTitle: part.part_title,
    durationSec: part.duration_sec,
    subtitlePath: part.subtitle_path ?? null,
    subtitleSource: part.subtitle_source ?? null,
    subtitleLang: part.subtitle_lang ?? null,
    sourcePath: part.source_path ?? null,
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
  };
}

export async function getVideoStateFromDb(db: Db, identity: VideoIdentity) {
  const video = await getVideoByIdentity(db, identity);
  if (!video) {
    return null;
  }

  return {
    video,
    parts: await listVideoParts(db, video.id),
    pendingSummaryParts: await listPendingSummaryParts(db, video.id),
    pendingPublishParts: await listPendingPublishParts(db, video.id),
  };
}
