import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { getVideoById, listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/index";
import { buildOwnerDirName, buildVideoWorkDirName, ensureVideoWorkDir, resolveVideoWorkDir } from "../scripts/lib/shared/work-paths";

test("buildVideoWorkDirName strips the owner prefix and keeps the BV suffix", () => {
  assert.equal(
    buildVideoWorkDirName({
      title: "Streamer 2026.04.17 18.30.02 Danmu",
      ownerName: "Streamer",
      bvid: "BV1ABC",
    }),
    "2026.04.17-18.30.02-Danmu__BV1ABC",
  );
});

test("buildOwnerDirName appends mid only when another owner already uses the same readable name", () => {
  assert.equal(buildOwnerDirName({
    ownerName: "Streamer",
    ownerMid: 100,
    existingVideos: [
      {
        id: 1,
        owner_mid: 200,
        owner_name: "Streamer",
        owner_dir_name: "Streamer",
      },
    ],
    currentVideoId: 2,
  }), "Streamer__mid-100");
});

test("ensureVideoWorkDir migrates legacy BV directories and rewrites subtitle paths", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-work-paths-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVWORK123",
      aid: 1,
      title: "Streamer 2026.04.17 18.30.02 Danmu",
      ownerName: "Streamer",
      ownerMid: 100,
      ownerDirName: "Streamer",
      workDirName: "2026.04.17-18.30.02-Danmu__BVWORK123",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 30,
      subtitlePath: path.join(tempRoot, "work", "BVWORK123", "cid-101.srt"),
      subtitleSource: "local",
      isDeleted: false,
    });

    const legacyDir = path.join(tempRoot, "work", "BVWORK123");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "cid-101.srt"), "subtitle", "utf8");

    const resolvedDir = ensureVideoWorkDir({
      db,
      video,
      workRoot: "work",
      repoRoot: tempRoot,
    });

    const expectedDir = resolveVideoWorkDir(video, "work", tempRoot);
    assert.equal(resolvedDir, expectedDir);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(fs.existsSync(path.join(expectedDir, "cid-101.srt")), true);

    const migratedPart = listVideoParts(db, video.id)[0];
    assert.equal(migratedPart.subtitle_path, path.join(expectedDir, "cid-101.srt"));
    assert.equal(getVideoById(db, video.id)?.owner_dir_name, "Streamer");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
