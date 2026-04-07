export function parseSrt(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    if (lines.length < 2) {
      continue;
    }

    let timeLineIndex = 0;
    if (!lines[0].includes("-->") && lines[1]?.includes("-->")) {
      timeLineIndex = 1;
    }

    const timeLine = lines[timeLineIndex];
    if (!timeLine?.includes("-->")) {
      continue;
    }

    const [startText, endText] = timeLine.split("-->").map((part) => part.trim());
    const startSec = parseSrtTimestamp(startText);
    const endSec = parseSrtTimestamp(endText);
    const textLines = lines.slice(timeLineIndex + 1).filter((line) => line.trim() !== "");
    const cueText = textLines.join("\n").trim();

    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !cueText) {
      continue;
    }

    cues.push({
      startSec,
      endSec,
      text: cueText,
    });
  }

  return cues;
}

export function buildSummarySegmentsFromSrt(srtText, durationSec = null) {
  const cues = parseSrt(srtText);
  if (cues.length === 0) {
    return [];
  }

  const effectiveDuration = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : Math.ceil(cues[cues.length - 1].endSec);

  const windowSize = chooseWindowSize(effectiveDuration, cues.length);
  if (!windowSize) {
    return [{
      startSec: 0,
      endSec: effectiveDuration,
      text: cues.map((cue) => cue.text).join("\n").trim(),
    }];
  }

  const segments = [];
  let current = null;

  for (const cue of cues) {
    if (!current) {
      current = createSegment(cue);
      continue;
    }

    const exceedsWindow = cue.endSec - current.startSec > windowSize;
    if (exceedsWindow) {
      segments.push(finalizeSegment(current));
      current = createSegment(cue);
      continue;
    }

    current.endSec = cue.endSec;
    current.texts.push(cue.text);
  }

  if (current) {
    segments.push(finalizeSegment(current));
  }

  return segments;
}

export function formatSummaryTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseSrtTimestamp(value) {
  const match = String(value ?? "").match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!match) {
    return Number.NaN;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const milliseconds = Number(match[4] ?? 0);
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function chooseWindowSize(durationSec, cueCount) {
  if (durationSec < 6 * 60 || cueCount < 25) {
    return null;
  }

  if (durationSec <= 20 * 60) {
    return 5 * 60;
  }

  return 8 * 60;
}

function createSegment(cue) {
  return {
    startSec: cue.startSec,
    endSec: cue.endSec,
    texts: [cue.text],
  };
}

function finalizeSegment(segment) {
  return {
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.texts.join("\n").trim(),
  };
}
