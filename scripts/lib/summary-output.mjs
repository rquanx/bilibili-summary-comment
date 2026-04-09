import { parseSummaryBlocks } from "./summary-format.mjs";

export function normalizeSummaryOutput(text, pageNo) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const blocks = parseSummaryBlocks(normalized);
  if (blocks.length <= 1 || blocks.some((block) => block.page !== pageNo)) {
    return normalized;
  }

  const markerPattern = new RegExp(`^<${pageNo}P>\\s*`, "u");
  const bodyLines = [];

  for (const block of blocks) {
    const lines = block.lines.map((line, index) => (index === 0 ? line.replace(markerPattern, "") : line));

    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }

    bodyLines.push(...lines);
  }

  const compactBody = trimTrailingEmptyLines(bodyLines);
  if (compactBody.length === 0) {
    return `<${pageNo}P>`;
  }

  return [`<${pageNo}P>`, ...compactBody].join("\n").trim();
}

function trimTrailingEmptyLines(lines) {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }
  return result;
}
