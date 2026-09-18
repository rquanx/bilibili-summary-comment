import assert from "node:assert/strict";
import test from "node:test";

import {
  getVideoByIdentity,
  insertPipelineEvent,
  listPendingPublishParts,
  listPipelineEvents,
  openDatabase,
  runInTransaction,
  upsertVideo,
  upsertVideoPart,
} from "../src/infra/db/index";

const postgresTestUrl = String(process.env.POSTGRES_TEST_URL ?? "").trim();

test("PostgreSQL storage supports writes, reads, pending publish, events, and rollback", {
  skip: postgresTestUrl ? false : "POSTGRES_TEST_URL is not configured",
}, async () => {
  const db = openDatabase(postgresTestUrl);
  const bvid = `BVPG${Date.now().toString(36).toUpperCase()}`;
  const rollbackMarker = new Error("rollback-postgres-storage-test");

  try {
    await assert.rejects(
      runInTransaction(db, async () => {
        const video = await upsertVideo(db, {
          bvid,
          aid: -Date.now(),
          title: "PostgreSQL integration test",
          pageCount: 1,
        });
        await upsertVideoPart(db, {
          videoId: video.id,
          pageNo: 1,
          cid: -Date.now() - 1,
          partTitle: "P1",
          durationSec: 60,
          summaryText: "<1P> 1#00:00 integration test",
          summaryHash: "postgres-integration-test",
          published: false,
          isDeleted: false,
        });
        await insertPipelineEvent(db, {
          videoId: video.id,
          bvid,
          videoTitle: video.title,
          scope: "test",
          action: "postgres-storage",
          status: "succeeded",
          message: "integration test",
        });

        const pending = await listPendingPublishParts(db, video.id);
        assert.equal(pending.length, 1);
        assert.equal(pending[0].page_no, 1);

        const events = await listPipelineEvents(db, { bvid, limit: 10 });
        assert.equal(events.length, 1);
        assert.equal(events[0].action, "postgres-storage");

        throw rollbackMarker;
      }),
      (error) => error === rollbackMarker,
    );

    assert.equal(await getVideoByIdentity(db, { bvid }), null);
  } finally {
    await db.close?.();
  }
});
