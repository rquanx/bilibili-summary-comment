import { getBvid } from "../bili/comment-utils.mjs";

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
