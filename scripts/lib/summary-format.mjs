const PAGE_MARKER_PATTERN = /^(?:<(?<bracketPage>\d+)P>|(?<plainPage>\d+)P)\s*(?<rest>.*)$/u;

export function normalizeSummaryMarkers(text) {
  const lines = splitLines(text);
  const normalizedLines = lines.map((line) => {
    const match = line.match(PAGE_MARKER_PATTERN);
    if (!match) {
      return line;
    }

    const page = Number(match.groups?.bracketPage ?? match.groups?.plainPage);
    const rest = (match.groups?.rest ?? "").trim();
    return rest ? `<${page}P> ${rest}` : `<${page}P>`;
  });

  return normalizedLines.join("\n").trim();
}

export function parseSummaryBlocks(text) {
  const normalized = normalizeSummaryMarkers(text);
  if (!normalized) {
    return [];
  }

  const lines = splitLines(normalized);
  const blocks = [];
  let currentBlock = null;

  for (const line of lines) {
    const match = line.match(/^<(?<page>\d+)P>\s*(?<rest>.*)$/u);
    if (match) {
      if (currentBlock) {
        currentBlock.text = trimTrailingEmptyLines(currentBlock.lines).join("\n").trim();
        blocks.push(currentBlock);
      }

      const page = Number(match.groups?.page);
      const firstLine = match.groups?.rest ? `<${page}P> ${match.groups.rest.trim()}` : `<${page}P>`;
      currentBlock = {
        page,
        marker: `<${page}P>`,
        lines: [firstLine],
        text: "",
      };
      continue;
    }

    if (!currentBlock) {
      continue;
    }

    currentBlock.lines.push(line);
  }

  if (currentBlock) {
    currentBlock.text = trimTrailingEmptyLines(currentBlock.lines).join("\n").trim();
    blocks.push(currentBlock);
  }

  return blocks.filter((block) => block.text);
}

export function extractCoveredPages(text) {
  return [...new Set(parseSummaryBlocks(text).map((block) => block.page))].sort((a, b) => a - b);
}

export function groupSummaryBlocksByPage(text) {
  const groups = new Map();
  for (const block of parseSummaryBlocks(text)) {
    const existing = groups.get(block.page);
    if (!existing) {
      groups.set(block.page, {
        page: block.page,
        marker: block.marker,
        text: block.text,
      });
      continue;
    }

    existing.text = `${existing.text}\n\n${block.text}`.trim();
  }

  return [...groups.values()].sort((a, b) => a.page - b.page);
}

export function splitSummaryForComments(text, maxLength = 1000) {
  const blocks = parseSummaryBlocks(text);
  if (blocks.length === 0) {
    return [];
  }

  const chunks = [];
  let currentChunk = "";
  let currentPages = [];

  for (const block of blocks) {
    if (block.text.length > maxLength) {
      throw new Error(`Summary block ${block.marker} exceeds comment max length ${maxLength}`);
    }

    const candidate = currentChunk ? `${currentChunk}\n\n${block.text}` : block.text;
    if (candidate.length <= maxLength) {
      currentChunk = candidate;
      currentPages.push(block.page);
      continue;
    }

    if (currentChunk) {
      chunks.push({
        message: currentChunk.trim(),
        pages: [...new Set(currentPages)].sort((a, b) => a - b),
      });
    }

    currentChunk = block.text;
    currentPages = [block.page];
  }

  if (currentChunk) {
    chunks.push({
      message: currentChunk.trim(),
      pages: [...new Set(currentPages)].sort((a, b) => a - b),
    });
  }

  return chunks;
}

function splitLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

function trimTrailingEmptyLines(lines) {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }
  return result;
}
