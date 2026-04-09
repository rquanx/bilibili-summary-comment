import {
  addDatabaseOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools.mjs";
import { listPipelineEvents, openDatabase } from "../lib/db/index.mjs";

const command = addDatabaseOption(
  createCliCommand({
    name: "inspect-pipeline-events",
    description: "Inspect recent pipeline events from SQLite.",
  })
    .option("--bvid <bvid>", "Optional. Filter by Bilibili BV id.")
    .option("--since-hours <hours>", "Optional. Only show recent events newer than this many hours.", parsePositiveIntegerArg)
    .option("--limit <count>", "Optional. Max event rows to inspect.", parsePositiveIntegerArg)
    .option("--json", "Optional. Print JSON instead of text report."),
);

await runCli({
  command,
  loadEnv: false,
  async handler(args) {
    const dbPath = args.db ?? "work/pipeline.sqlite3";
    const db = openDatabase(dbPath);

    try {
      const bvid = normalizeNullableText(args.bvid);
      const sinceHours = Math.max(1, Number(args["since-hours"] ?? 72) || 72);
      const sinceIso = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
      const limit = Math.max(1, Number(args.limit) || 200);
      const events = listPipelineEvents(db, {
        bvid,
        sinceIso,
        limit,
      }).map(parseEventRow);
      const pendingParts = listPendingParts(db, bvid);
      const duplicateSuccesses = buildDuplicateSuccesses(events);
      const publishStats = buildPublishStats(events);

      const report = {
        ok: true,
        dbPath,
        filter: {
          bvid,
          sinceHours,
          sinceIso,
          limit,
        },
        nextPendingPart: pendingParts[0] ?? null,
        pendingParts,
        recentEvents: events,
        duplicateSuccesses,
        publishStats,
      };

      if (args.json) {
        return report;
      }

      printTextReport(report);
      return undefined;
    } finally {
      db.close?.();
    }
  },
});

function listPendingParts(db, bvid) {
  return db.prepare(`
    SELECT
      v.bvid,
      v.title AS video_title,
      p.page_no,
      p.cid,
      p.part_title,
      p.subtitle_source,
      p.updated_at
    FROM video_parts p
    JOIN videos v ON v.id = p.video_id
    WHERE p.is_deleted = 0
      AND (p.summary_text IS NULL OR TRIM(p.summary_text) = '')
      AND (? IS NULL OR v.bvid = ?)
    ORDER BY v.updated_at DESC, v.id DESC, p.page_no ASC
  `).all(bvid, bvid);
}

function parseEventRow(row) {
  return {
    ...row,
    details: parseEventDetails(row.details_json),
  };
}

function parseEventDetails(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {
      raw,
    };
  }
}

function buildDuplicateSuccesses(events) {
  const grouped = new Map();

  for (const event of events) {
    if (event.status !== "succeeded") {
      continue;
    }

    const publishMode = normalizeNullableText(event.details?.publishMode);
    const key = [
      event.bvid ?? "",
      event.page_no ?? "",
      event.scope,
      event.action,
      publishMode ?? "",
    ].join("|");
    const current = grouped.get(key) ?? {
      bvid: event.bvid,
      videoTitle: event.video_title,
      pageNo: event.page_no,
      partTitle: event.part_title,
      scope: event.scope,
      action: event.action,
      publishMode,
      count: 0,
      firstAt: event.created_at,
      lastAt: event.created_at,
      runIds: new Set(),
    };

    current.count += 1;
    current.firstAt = current.firstAt < event.created_at ? current.firstAt : event.created_at;
    current.lastAt = current.lastAt > event.created_at ? current.lastAt : event.created_at;
    if (event.run_id) {
      current.runIds.add(event.run_id);
    }
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => right.count - left.count || right.lastAt.localeCompare(left.lastAt))
    .map((entry) => ({
      ...entry,
      runIds: [...entry.runIds],
      runCount: entry.runIds.size,
    }));
}

function buildPublishStats(events) {
  const counts = new Map();

  for (const event of events) {
    if (event.scope !== "publish" || event.action !== "comment-thread" || event.status !== "succeeded") {
      continue;
    }

    const mode = normalizeNullableText(event.details?.publishMode) ?? "unknown";
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([publishMode, count]) => ({ publishMode, count }))
    .sort((left, right) => right.count - left.count || left.publishMode.localeCompare(right.publishMode));
}

function printTextReport(report) {
  const maxPrintedPendingParts = 20;
  const lines = [
    `DB: ${report.dbPath}`,
    `Filter: bvid=${report.filter.bvid ?? "all"}, since=${report.filter.sinceIso}, limit=${report.filter.limit}`,
    "",
    `Next pending part: ${
      report.nextPendingPart
        ? `${report.nextPendingPart.bvid} | ${report.nextPendingPart.video_title} | P${report.nextPendingPart.page_no} | ${report.nextPendingPart.part_title}`
        : "none"
    }`,
    "",
    "Current pending parts:",
  ];

  if (report.pendingParts.length === 0) {
    lines.push("  none");
  } else {
    for (const part of report.pendingParts.slice(0, maxPrintedPendingParts)) {
      lines.push(
        `  ${part.bvid} | ${part.video_title} | P${part.page_no} | ${part.part_title} | subtitle=${part.subtitle_source ?? "missing"} | updated=${part.updated_at}`,
      );
    }
    if (report.pendingParts.length > maxPrintedPendingParts) {
      lines.push(`  ... ${report.pendingParts.length - maxPrintedPendingParts} more pending parts omitted`);
    }
  }

  lines.push("");
  lines.push("Recent events:");
  if (report.recentEvents.length === 0) {
    lines.push("  none");
  } else {
    for (const event of report.recentEvents) {
      const pageLabel = hasPageNo(event.page_no) ? ` | P${event.page_no}` : "";
      const partTitle = normalizeNullableText(event.part_title);
      const messageSuffix = normalizeNullableText(event.message) ? ` | ${event.message}` : "";
      lines.push(
        `  ${event.created_at} | ${shortRunId(event.run_id)} | ${event.bvid ?? "n/a"}${pageLabel} | ${event.scope}/${event.action}/${event.status}${partTitle ? ` | ${partTitle}` : ""}${messageSuffix}`,
      );
    }
  }

  lines.push("");
  lines.push("Duplicate successful work:");
  if (report.duplicateSuccesses.length === 0) {
    lines.push("  none");
  } else {
    for (const item of report.duplicateSuccesses) {
      const pageLabel = hasPageNo(item.pageNo) ? `P${item.pageNo}` : "video-level";
      const modeLabel = item.publishMode ? ` | mode=${item.publishMode}` : "";
      lines.push(
        `  ${item.bvid ?? "n/a"} | ${pageLabel} | ${item.scope}/${item.action}${modeLabel} | count=${item.count} | runs=${item.runCount} | ${item.firstAt} -> ${item.lastAt}`,
      );
    }
  }

  lines.push("");
  lines.push("Publish mode stats:");
  if (report.publishStats.length === 0) {
    lines.push("  none");
  } else {
    for (const item of report.publishStats) {
      lines.push(`  ${item.publishMode}: ${item.count}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function shortRunId(runId) {
  const normalized = normalizeNullableText(runId);
  return normalized ? normalized.slice(0, 8) : "no-runid";
}

function normalizeNullableText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function hasPageNo(value) {
  return value !== null && value !== undefined && Number.isInteger(Number(value));
}
