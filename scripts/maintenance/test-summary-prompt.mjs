import fs from "node:fs";
import path from "node:path";
import { buildSummarySegmentsFromSrt, formatSummaryTime, parseSrt } from "../lib/subtitle/srt-utils.mjs";
import { getRepoRoot, loadDotEnvIfPresent } from "../lib/shared/runtime-tools.mjs";
import { normalizeSummaryOutput, requestSummary, resolveSummaryConfig } from "../lib/summary/index.mjs";

const SHORT_TARGET_SEC = 60;
const SHORT_MIN_SEC = 20;
const SHORT_MAX_SEC = 120;
const LONG_MIN_SEC = 30 * 60;

async function main() {
  loadDotEnvIfPresent();

  const config = resolveSummaryConfig();
  if (!config.apiKey) {
    throw new Error("Missing summary API key. Set SUMMARY_API_KEY or OPENAI_API_KEY.");
  }

  const repoRoot = getRepoRoot();
  const workRoot = path.join(repoRoot, "work");
  const candidates = collectSubtitleCandidates(workRoot);

  if (candidates.length === 0) {
    throw new Error(`No usable .srt files found under ${workRoot}`);
  }

  const shortCandidate = pickShortCandidate(candidates);
  const longCandidate = pickLongCandidate(candidates, shortCandidate?.filePath);

  if (!shortCandidate) {
    throw new Error(`Could not find a short subtitle sample between ${SHORT_MIN_SEC}s and ${SHORT_MAX_SEC}s in ${workRoot}`);
  }

  if (!longCandidate) {
    throw new Error(`Could not find a long subtitle sample longer than ${LONG_MIN_SEC}s in ${workRoot}`);
  }

  const timestamp = createTimestamp();
  const outputDir = path.join(workRoot, "prompt-test", timestamp);
  fs.mkdirSync(outputDir, { recursive: true });

  const samples = [
    { name: "short", pageNo: inferPageNo(shortCandidate.filePath, 1), candidate: shortCandidate },
    { name: "long", pageNo: inferPageNo(longCandidate.filePath, 2), candidate: longCandidate },
  ];

  const results = [];
  for (const sample of samples) {
    console.log(`[${sample.name}] ${sample.candidate.relativePath} (${formatSummaryTime(sample.candidate.durationSec)})`);
    const result = await runSample({
      sampleName: sample.name,
      pageNo: sample.pageNo,
      candidate: sample.candidate,
      outputDir,
      config,
      workRoot,
    });
    results.push(result);
    console.log(`  -> ${path.relative(repoRoot, result.summaryPath)}`);
  }

  const reportPath = path.join(outputDir, "report.md");
  fs.writeFileSync(reportPath, buildReport(results, repoRoot), "utf8");

  console.log("");
  console.log(`Done. Output saved to ${path.relative(repoRoot, outputDir)}`);
}

async function runSample({ sampleName, pageNo, candidate, outputDir, config, workRoot }) {
  const subtitleText = fs.readFileSync(candidate.filePath, "utf8");
  const segments = buildSummarySegmentsFromSrt(subtitleText, candidate.durationSec);
  const partTitle = buildPartTitle(candidate, workRoot);
  const rawSummary = await requestSummary({
    pageNo,
    partTitle,
    durationSec: candidate.durationSec,
    subtitleText,
    segments,
    model: config.model,
    apiKey: config.apiKey,
    apiBaseUrl: config.apiBaseUrl,
    apiFormat: config.apiFormat,
  });

  const normalizedSummary = normalizeSummaryOutput(rawSummary, pageNo);
  const promptPath = path.join(outputDir, `${sampleName}-prompt.md`);
  const requestPath = path.join(outputDir, `${sampleName}-request.json`);
  const summaryPath = path.join(outputDir, `${sampleName}-summary.md`);

  fs.writeFileSync(promptPath, buildPromptSnapshot({
    sampleName,
    pageNo,
    partTitle,
    candidate,
    subtitleText,
    segments,
  }), "utf8");
  fs.writeFileSync(requestPath, JSON.stringify(buildRequestSnapshot({
    pageNo,
    partTitle,
    durationSec: candidate.durationSec,
    subtitleText,
    segments,
  }), null, 2), "utf8");
  fs.writeFileSync(summaryPath, `${normalizedSummary}\n`, "utf8");

  return {
    sampleName,
    pageNo,
    durationSec: candidate.durationSec,
    relativePath: candidate.relativePath,
    promptPath,
    requestPath,
    summaryPath,
  };
}

function collectSubtitleCandidates(workRoot) {
  const filePaths = walkFiles(workRoot).filter((filePath) => filePath.toLowerCase().endsWith(".srt"));
  const candidates = [];

  for (const filePath of filePaths) {
    if (shouldSkipPath(filePath)) {
      continue;
    }

    const subtitleText = fs.readFileSync(filePath, "utf8");
    const cues = parseSrt(subtitleText);
    if (cues.length === 0) {
      continue;
    }

    const durationSec = Math.ceil(cues[cues.length - 1].endSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      continue;
    }

    candidates.push({
      filePath,
      relativePath: path.relative(workRoot, filePath),
      durationSec,
      cueCount: cues.length,
      textLength: subtitleText.trim().length,
    });
  }

  return candidates;
}

function walkFiles(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const filePaths = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...walkFiles(fullPath));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(fullPath);
    }
  }

  return filePaths;
}

function shouldSkipPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/prompt-test/") || normalized.includes("/prompt-test-mock/") || normalized.includes("/.locks/");
}

function pickShortCandidate(candidates) {
  return [...candidates]
    .filter((candidate) => candidate.durationSec >= SHORT_MIN_SEC && candidate.durationSec <= SHORT_MAX_SEC)
    .sort((left, right) => {
      const leftScore = Math.abs(left.durationSec - SHORT_TARGET_SEC);
      const rightScore = Math.abs(right.durationSec - SHORT_TARGET_SEC);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return right.textLength - left.textLength;
    })[0] ?? null;
}

function pickLongCandidate(candidates, excludedFilePath = null) {
  return [...candidates]
    .filter((candidate) => candidate.durationSec > LONG_MIN_SEC && candidate.filePath !== excludedFilePath)
    .sort((left, right) => {
      const leftScore = left.durationSec - LONG_MIN_SEC;
      const rightScore = right.durationSec - LONG_MIN_SEC;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return right.textLength - left.textLength;
    })[0] ?? null;
}

function inferPageNo(filePath, fallbackPageNo) {
  const basename = path.basename(filePath);
  const match = basename.match(/^p(\d+)\.srt$/i);
  if (!match) {
    return fallbackPageNo;
  }

  const pageNo = Number(match[1]);
  return Number.isFinite(pageNo) && pageNo > 0 ? pageNo : fallbackPageNo;
}

function buildPartTitle(candidate, workRoot) {
  const relativePath = path.relative(workRoot, candidate.filePath);
  const parsed = path.parse(relativePath);
  return `${parsed.dir}/${parsed.base}`.replace(/\\/g, "/");
}

function buildPromptSnapshot({ sampleName, pageNo, partTitle, candidate, subtitleText, segments }) {
  const lines = [
    `sample: ${sampleName}`,
    "promptSource: scripts/lib/summary/index.mjs#requestSummary",
    "note: this test calls requestSummary directly and does not duplicate prompt text here.",
    `pageNo: ${pageNo}`,
    `partTitle: ${partTitle}`,
    `source: ${candidate.relativePath.replace(/\\/g, "/")}`,
    `duration: ${formatSummaryTime(candidate.durationSec)}`,
    `cueCount: ${candidate.cueCount}`,
    `segmentCount: ${segments.length}`,
    "",
    "subtitle preview:",
    subtitleText.slice(0, 4000).trim(),
  ];

  return lines.join("\n").trimEnd() + "\n";
}

function buildRequestSnapshot({ pageNo, partTitle, durationSec, subtitleText, segments }) {
  const segmentPayload =
    segments.length > 0
      ? segments.map((segment) => ({
          start: formatSummaryTime(segment.startSec),
          end: formatSummaryTime(segment.endSec),
          text: segment.text,
        }))
      : null;

  return {
    page: pageNo,
    partTitle,
    durationSec,
    subtitleFormat: "srt",
    segments: segmentPayload,
    rawSubtitleTextWhenSegmentParsingFailed: segmentPayload ? null : subtitleText,
  };
}

function buildReport(results, repoRoot) {
  const lines = ["# Prompt Test", ""];

  for (const result of results) {
    lines.push(`## ${result.sampleName}`);
    lines.push(`- source: ${result.relativePath}`);
    lines.push(`- duration: ${formatSummaryTime(result.durationSec)}`);
    lines.push(`- prompt: ${path.relative(repoRoot, result.promptPath).replace(/\\/g, "/")}`);
    lines.push(`- request: ${path.relative(repoRoot, result.requestPath).replace(/\\/g, "/")}`);
    lines.push(`- summary: ${path.relative(repoRoot, result.summaryPath).replace(/\\/g, "/")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function createTimestamp() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
