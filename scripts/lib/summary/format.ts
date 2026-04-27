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

export function inspectSummaryPageMarkers(text, availablePages = null) {
  const blocks = parseSummaryBlocks(text);
  const pageCounts = new Map();

  for (const block of blocks) {
    pageCounts.set(block.page, (pageCounts.get(block.page) ?? 0) + 1);
  }

  const pages = [...pageCounts.keys()].sort((a, b) => a - b);
  const duplicatePages = pages.filter((page) => (pageCounts.get(page) ?? 0) > 1);
  const allowedPages = Array.isArray(availablePages) ? new Set(availablePages) : null;
  const invalidPages = allowedPages
    ? pages.filter((page) => !allowedPages.has(page))
    : [];

  return {
    blocks,
    pages,
    duplicatePages,
    invalidPages,
  };
}

export function compactPasteLinkSummaryRanges(text) {
  const blocks = parseSummaryBlocks(text);
  if (blocks.length === 0) {
    return "";
  }

  const compactedBlocks = [];
  let pendingGroup = null;

  const flushPendingGroup = () => {
    if (!pendingGroup) {
      return;
    }

    const marker = pendingGroup.startPage === pendingGroup.endPage
      ? `<${pendingGroup.startPage}P>`
      : `<${pendingGroup.startPage}P> ~ <${pendingGroup.endPage}P>`;
    compactedBlocks.push(`${marker}\n${pendingGroup.url}`);
    pendingGroup = null;
  };

  for (const block of blocks) {
    const pasteUrl = extractPasteLinkOnlyBody(block.text, block.marker);
    if (!pasteUrl) {
      flushPendingGroup();
      compactedBlocks.push(block.text);
      continue;
    }

    if (
      pendingGroup
      && pendingGroup.url === pasteUrl
      && block.page === pendingGroup.endPage + 1
    ) {
      pendingGroup.endPage = block.page;
      continue;
    }

    flushPendingGroup();
    pendingGroup = {
      startPage: block.page,
      endPage: block.page,
      url: pasteUrl,
    };
  }

  flushPendingGroup();
  return compactedBlocks.join("\n\n").trim();
}

export function splitSummaryForComments(text, maxLength = 1000) {
  const blocks = parseSummaryBlocks(text).flatMap((block) => splitSummaryBlockForComments(block, maxLength));
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

function splitSummaryBlockForComments(block, maxLength) {
  if (block.text.length <= maxLength) {
    return [block];
  }

  const body = extractBlockBody(block.text, block.marker);
  const maxBodyLength = maxLength - block.marker.length - 1;
  if (maxBodyLength <= 0) {
    throw new Error(`Summary block ${block.marker} exceeds comment max length ${maxLength}`);
  }

  const bodyChunks = splitBlockBodyText(body, maxBodyLength);
  return bodyChunks.map((bodyChunk) => ({
    ...block,
    text: `${block.marker} ${bodyChunk}`.trim(),
  }));
}

function extractBlockBody(blockText, marker) {
  const normalizedText = String(blockText ?? "").trim();
  if (!normalizedText.startsWith(marker)) {
    return normalizedText;
  }

  return normalizedText.slice(marker.length).trim();
}

function extractPasteLinkOnlyBody(blockText, marker) {
  const body = extractBlockBody(blockText, marker);
  return /^https:\/\/paste\.rs\/\S+$/u.test(body) ? body : null;
}

function splitBlockBodyText(text, maxBodyLength) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return [""];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxBodyLength) {
    const splitIndex = findPreferredSplitIndex(remaining, maxBodyLength);
    const head = remaining.slice(0, splitIndex).trimEnd();
    if (!head) {
      break;
    }

    chunks.push(head);
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function findPreferredSplitIndex(text, maxBodyLength) {
  const safeMaxLength = Math.max(1, Number(maxBodyLength) || 1);
  const maxIndex = Math.min(text.length, safeMaxLength);
  const minimumPreferredIndex = Math.max(1, Math.floor(maxIndex * 0.6));
  const preferredPatterns = [
    /\n{2,}/gu,
    /\n/gu,
    /[。！？；]/gu,
    /[，、]/gu,
    /\s+/gu,
  ];

  for (const pattern of preferredPatterns) {
    const candidate = findLastPatternBoundary(text, pattern, maxIndex);
    if (candidate >= minimumPreferredIndex) {
      return candidate;
    }
  }

  return maxIndex;
}

function findLastPatternBoundary(text, pattern, maxIndex) {
  let lastIndex = -1;
  for (const match of text.slice(0, maxIndex).matchAll(pattern)) {
    const boundaryIndex = Number(match.index ?? -1) + String(match[0] ?? "").length;
    if (boundaryIndex > 0 && boundaryIndex <= maxIndex) {
      lastIndex = boundaryIndex;
    }
  }

  return lastIndex;
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
