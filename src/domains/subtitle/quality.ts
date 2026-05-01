import { formatSrt, parseSrt } from "./srt-utils";

const VOLUNTEER_CREDIT_FULL_PATTERN = /^(?:\u5b57\u5e55\u5fd7\u613f\u8005\u674e\u5b97\u76db)+$/u;
const VOLUNTEER_CREDIT_PARTIAL_PATTERNS = [
  /^\u5b57\u5e55\u5fd7\u613f\u8005$/u,
  /^\u674e\u5b97\u76db$/u,
];

export function inspectSubtitleQuality(srtText: string | null | undefined) {
  const cues = parseSrt(srtText);
  const totalCueCount = cues.length;

  if (totalCueCount === 0) {
    return {
      totalCueCount,
      removedCueCount: 0,
      remainingCueCount: 0,
      volunteerCreditCueCount: 0,
      volunteerCreditRatio: 0,
      longestVolunteerCreditRun: 0,
      severeVolunteerCreditIssue: false,
      sanitizedSrt: "",
    };
  }

  let longestVolunteerCreditRun = 0;
  let currentVolunteerCreditRun = 0;
  const sanitizedCues = [];
  let removedCueCount = 0;

  for (const cue of cues) {
    if (isLikelyVolunteerCreditCue(cue.text)) {
      removedCueCount += 1;
      currentVolunteerCreditRun += 1;
      longestVolunteerCreditRun = Math.max(longestVolunteerCreditRun, currentVolunteerCreditRun);
      continue;
    }

    currentVolunteerCreditRun = 0;
    sanitizedCues.push(cue);
  }

  const remainingCueCount = sanitizedCues.length;
  const volunteerCreditCueCount = removedCueCount;
  const volunteerCreditRatio = volunteerCreditCueCount / totalCueCount;
  const severeVolunteerCreditIssue = volunteerCreditCueCount > 0 && (
    remainingCueCount === 0
    || volunteerCreditRatio >= 0.6
    || (volunteerCreditCueCount >= 4 && (
      volunteerCreditRatio >= 0.25
      || longestVolunteerCreditRun >= 2
      || remainingCueCount <= 2
    ))
    || (volunteerCreditCueCount >= 3 && longestVolunteerCreditRun >= 3)
  );

  return {
    totalCueCount,
    removedCueCount,
    remainingCueCount,
    volunteerCreditCueCount,
    volunteerCreditRatio,
    longestVolunteerCreditRun,
    severeVolunteerCreditIssue,
    sanitizedSrt: remainingCueCount > 0 ? `${formatSrt(sanitizedCues).trim()}\n` : "",
  };
}

export function isLikelyVolunteerCreditCue(text: string | null | undefined) {
  const normalized = String(text ?? "")
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

  if (!normalized) {
    return false;
  }

  return VOLUNTEER_CREDIT_FULL_PATTERN.test(normalized)
    || VOLUNTEER_CREDIT_PARTIAL_PATTERNS.some((pattern) => pattern.test(normalized));
}
