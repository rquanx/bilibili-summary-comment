import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  createClient,
  readCookie,
} from "../lib/bili/comment-utils";
import { createCliError } from "../lib/cli/errors";
import {
  addCookieOptions,
  addDatabaseOption,
  addVideoIdentityOptions,
  createCliCommand,
  requireNonEmptyString,
  runCli,
} from "../lib/cli/tools";
import { groupSummaryBlocksByPage, inspectSummaryPageMarkers, normalizeSummaryMarkers } from "../lib/summary/format";
import { openDatabase, savePartSummary } from "../lib/db/index";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "../lib/video/index";

const command = addDatabaseOption(
  addVideoIdentityOptions(
    addCookieOptions(
      createCliCommand({
        name: "import-summary-file",
        description: "Import summary blocks from a local summary file into SQLite.",
      })
        .option("--summary-file <path>", "Required. Summary markdown/text path."),
      { required: true },
    ),
  ),
);

await runCli({
  command,
  async handler(args) {
    const summaryFile = requireNonEmptyString(args["summary-file"], "--summary-file");
    const dbPath = typeof args.db === "string" && args.db.trim() ? args.db : "work/pipeline.sqlite3";

    const cookie = readCookie(args);
    const client = createClient(cookie);
    const db = openDatabase(dbPath);
    try {
      const snapshot = await fetchVideoSnapshot(client, args);
      const state = syncVideoSnapshotToDb(db, snapshot);

      const summaryText = normalizeSummaryMarkers(fs.readFileSync(summaryFile, "utf8"));
      const pageInspection = inspectSummaryPageMarkers(
        summaryText,
        state.parts.map((part) => part.page_no),
      );
      if (pageInspection.duplicatePages.length > 0 || pageInspection.invalidPages.length > 0) {
        throw createCliError("Summary file page markers are invalid", {
          summaryFile,
          duplicatePages: pageInspection.duplicatePages,
          invalidPages: pageInspection.invalidPages,
          availablePages: state.parts.map((part) => part.page_no),
        });
      }

      const pageGroups = groupSummaryBlocksByPage(summaryText);
      if (pageGroups.length === 0) {
        throw createCliError("No page markers found in summary file", { summaryFile });
      }

      const savedPages = [];
      for (const group of pageGroups) {
        const saved = savePartSummary(db, state.video.id, group.page, {
          summaryText: group.text,
          summaryHash: createHash("sha1").update(group.text).digest("hex"),
        });

        if (saved) {
          savedPages.push(group.page);
        }
      }

      return {
        ok: true,
        dbPath,
        summaryFile,
        video: {
          id: state.video.id,
          bvid: state.video.bvid,
          aid: state.video.aid,
          title: state.video.title,
        },
        savedPages,
      };
    } finally {
      db.close?.();
    }
  },
});
