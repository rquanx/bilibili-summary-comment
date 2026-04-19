export const EAST_8_TIMEZONE = "Asia/Shanghai";
const EAST_8_OFFSET = "+08:00";

interface TimeZoneParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

export function formatEast8Timestamp(date = new Date()): string {
  const parts = getTimeZoneParts(date, EAST_8_TIMEZONE);
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${EAST_8_OFFSET}`;
}

export function formatEast8Date(date = new Date()): string {
  const parts = getTimeZoneParts(date, EAST_8_TIMEZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatEast8Time(date = new Date()): string {
  const parts = getTimeZoneParts(date, EAST_8_TIMEZONE);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatEast8FilenameTimestamp(date = new Date()): string {
  const parts = getTimeZoneParts(date, EAST_8_TIMEZONE);
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${milliseconds}`;
}

export function formatDateInTimeZone(date = new Date(), timeZone = EAST_8_TIMEZONE): string {
  const parts = getTimeZoneParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function parseTimestamp(value: unknown): number {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return Number.NaN;
  }

  return Date.parse(normalized);
}

export function compareTimestampAsc(left: unknown, right: unknown): number {
  return compareTimestamp(left, right);
}

export function compareTimestampDesc(left: unknown, right: unknown): number {
  return compareTimestamp(right, left);
}

function compareTimestamp(left: unknown, right: unknown): number {
  const leftMs = parseTimestamp(left);
  const rightMs = parseTimestamp(right);
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);

  if (leftValid && rightValid && leftMs !== rightMs) {
    return leftMs - rightMs;
  }

  if (leftValid !== rightValid) {
    return leftValid ? 1 : -1;
  }

  return String(left ?? "").localeCompare(String(right ?? ""));
}

function getTimeZoneParts(date: Date, timeZone: string): TimeZoneParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    year: values.year ?? "0000",
    month: values.month ?? "00",
    day: values.day ?? "00",
    hour: values.hour ?? "00",
    minute: values.minute ?? "00",
    second: values.second ?? "00",
  };
}
