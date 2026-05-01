import { createHash } from "node:crypto";
import type { SnapshotChangeSet, VideoPartRecord, VideoSnapshotPage } from "../../infra/db/types";

export function detectSnapshotChanges(
  previousActiveParts: Array<Pick<VideoPartRecord, "cid" | "page_no">>,
  nextPages: Array<Pick<VideoSnapshotPage, "cid" | "pageNo">>,
): SnapshotChangeSet {
  const previousCids = previousActiveParts.map((part) => Number(part.cid));
  const nextCids = nextPages.map((page) => Number(page.cid));
  const moved = previousActiveParts
    .filter((part) => nextPages.some((page) => page.cid === part.cid && page.pageNo !== Number(part.page_no)))
    .map((part) => ({
      cid: Number(part.cid),
      fromPageNo: Number(part.page_no),
      toPageNo: Number(nextPages.find((page) => page.cid === part.cid)?.pageNo ?? part.page_no),
    }));
  const inserted = nextPages
    .filter((page) => !previousActiveParts.some((part) => Number(part.cid) === page.cid))
    .map((page) => ({ cid: page.cid, pageNo: page.pageNo }));
  const deleted = previousActiveParts
    .filter((part) => !nextPages.some((page) => page.cid === Number(part.cid)))
    .map((part) => ({ cid: Number(part.cid), pageNo: Number(part.page_no) }));

  const sameSequence =
    previousCids.length === nextCids.length && previousCids.every((cid, index) => cid === nextCids[index]);
  const appendOnly =
    previousCids.length <= nextCids.length && previousCids.every((cid, index) => cid === nextCids[index]);
  const requiresRebuild = previousCids.length > 0 && !sameSequence && !appendOnly;

  return {
    inserted,
    deleted,
    moved,
    previousCids,
    nextCids,
    sameSequence,
    appendOnly,
    requiresRebuild,
    rebuildReason: requiresRebuild ? "part-sequence-changed" : null,
  };
}

export function reindexSummaryText(summaryText: string | null | undefined, nextPageNo: number): string {
  const normalized = String(summaryText ?? "").trim();
  if (!normalized) {
    return normalized;
  }

  return normalized
    .replace(/<\d+P>/gu, `<${nextPageNo}P>`)
    .replace(
      /(?<=^<\d+P>\s)\d+#(?=\d{2}:\d{2}(?::\d{2})?\s)|^\d+#(?=\d{2}:\d{2}(?::\d{2})?\s)/gmu,
      `${nextPageNo}#`,
    );
}

export function createSummaryHash(summaryText: string | null | undefined): string {
  return createHash("sha1").update(`${String(summaryText ?? "").trim()}\n`).digest("hex");
}
