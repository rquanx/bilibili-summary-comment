import { getBvid } from "./bili-comment-utils.mjs";
import {
  getVideoByIdentity,
  listPendingPublishParts,
  listPendingSummaryParts,
  listVideoParts,
  upsertVideo,
  upsertVideoPart,
} from "./storage.mjs";

export async function fetchVideoSnapshot(client, args) {
  const directAid = args.oid ?? args.aid;
  const bvid = getBvid(args);

  let detail;
  if (bvid) {
    detail = await client.video.detail({ bvid });
  } else if (directAid !== undefined) {
    detail = await client.video.detail({ aid: Number(directAid) });
  } else {
    throw new Error("Missing required option: one of --oid, --aid, --bvid, --url");
  }

  const view = detail?.View;
  if (!view?.bvid || !Number.isInteger(Number(view.aid))) {
    throw new Error("Failed to fetch video detail");
  }

  const pages = Array.isArray(view.pages) ? view.pages : [];

  return {
    bvid: view.bvid,
    aid: Number(view.aid),
    title: view.title ?? "",
    pageCount: pages.length,
    pages: pages.map((page) => ({
      pageNo: Number(page.page),
      cid: Number(page.cid),
      partTitle: page.part ?? "",
      durationSec: Number(page.duration ?? 0),
    })),
  };
}

export function syncVideoSnapshotToDb(db, snapshot) {
  const video = upsertVideo(db, snapshot);
  const existingParts = new Map(listVideoParts(db, video.id).map((part) => [part.page_no, part]));

  for (const page of snapshot.pages) {
    const existingPart = existingParts.get(page.pageNo);
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: page.pageNo,
      cid: page.cid,
      partTitle: page.partTitle,
      durationSec: page.durationSec,
      subtitlePath: existingPart?.subtitle_path ?? null,
      subtitleSource: existingPart?.subtitle_source ?? null,
      subtitleLang: existingPart?.subtitle_lang ?? null,
      summaryText: existingPart?.summary_text ?? null,
      summaryHash: existingPart?.summary_hash ?? null,
      published: Boolean(existingPart?.published),
      publishedCommentRpid: existingPart?.published_comment_rpid ?? null,
      publishedAt: existingPart?.published_at ?? null,
    });
  }

  const parts = listVideoParts(db, video.id);
  return {
    video,
    parts,
    pendingSummaryParts: listPendingSummaryParts(db, video.id),
    pendingPublishParts: listPendingPublishParts(db, video.id),
  };
}

export function getVideoStateFromDb(db, identity) {
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
