import { buildBiliVideoUrl } from "../bili/video-url";

export type CliErrorDetails = Record<string, unknown>;

export interface ErrorJson extends Record<string, unknown> {
  ok: false;
  message: string;
  stack?: string;
}

interface ErrorLike {
  message?: unknown;
  stack?: unknown;
  code?: unknown;
  statusCode?: unknown;
  path?: unknown;
  method?: unknown;
  rawResponse?: unknown;
  bvid?: unknown;
  aid?: unknown;
  pageNo?: unknown;
  videoUrl?: unknown;
  logPath?: unknown;
  failedStep?: unknown;
  failedScope?: unknown;
  failedAction?: unknown;
  partTitle?: unknown;
}

export class CliError extends Error {
  details: CliErrorDetails;

  constructor(message: string, details: CliErrorDetails = {}) {
    super(message);
    this.name = "CliError";
    this.details = normalizeDetails(details);
  }
}

export function createCliError(message: string, details: CliErrorDetails = {}): CliError {
  return new CliError(message, details);
}

export function errorToJson(error: unknown, fallbackMessage = "Unknown error"): ErrorJson {
  const errorLike = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
  const payload: ErrorJson = {
    ok: false,
    message: typeof errorLike.message === "string" ? errorLike.message : fallbackMessage,
  };

  Object.assign(payload, extractErrorDetails(error));

  if (error instanceof CliError) {
    Object.assign(payload, error.details);
  }

  if (typeof errorLike.stack === "string" && errorLike.stack) {
    payload.stack = errorLike.stack;
  }

  return payload;
}

export function extractErrorDetails(error: unknown): CliErrorDetails {
  if (!error || typeof error !== "object") {
    return {};
  }

  const errorLike = error as ErrorLike;
  const details: CliErrorDetails = {};

  if (error instanceof CliError) {
    Object.assign(details, error.details);
  }

  if (errorLike.code !== undefined) {
    details.code = errorLike.code;
  }

  if (errorLike.statusCode !== undefined) {
    details.statusCode = errorLike.statusCode;
  }

  if (typeof errorLike.path === "string" && errorLike.path.trim()) {
    details.path = errorLike.path;
  }

  if (typeof errorLike.method === "string" && errorLike.method.trim()) {
    details.method = errorLike.method;
  }

  const responseData = normalizeResponseData(errorLike.rawResponse);
  if (responseData !== undefined) {
    details.responseData = responseData;
  }

  const videoUrl = normalizeVideoUrl({
    videoUrl: errorLike.videoUrl ?? details.videoUrl,
    bvid: errorLike.bvid ?? details.bvid,
    aid: errorLike.aid ?? details.aid,
    pageNo: errorLike.pageNo ?? details.pageNo,
  });
  if (videoUrl) {
    details.videoUrl = videoUrl;
  }

  if (typeof errorLike.logPath === "string" && errorLike.logPath.trim()) {
    details.logPath = errorLike.logPath.trim();
  }

  if (typeof errorLike.failedStep === "string" && errorLike.failedStep.trim()) {
    details.failedStep = errorLike.failedStep.trim();
  }

  if (typeof errorLike.failedScope === "string" && errorLike.failedScope.trim()) {
    details.failedScope = errorLike.failedScope.trim();
  }

  if (typeof errorLike.failedAction === "string" && errorLike.failedAction.trim()) {
    details.failedAction = errorLike.failedAction.trim();
  }

  if (typeof errorLike.partTitle === "string" && errorLike.partTitle.trim()) {
    details.partTitle = errorLike.partTitle.trim();
  }

  return details;
}

export function attachErrorDetails(error: unknown, details: CliErrorDetails): void {
  if (!error || typeof error !== "object") {
    return;
  }

  const target = error as Record<string, unknown>;
  const normalized = normalizeDetails(details);
  for (const [key, value] of Object.entries(normalized)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

function normalizeDetails(details: CliErrorDetails): CliErrorDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
}

function normalizeResponseData(rawResponse: unknown): unknown {
  if (!rawResponse || typeof rawResponse !== "object") {
    return undefined;
  }

  const responseLike = rawResponse as { data?: unknown };
  return isJsonSafeValue(responseLike.data) ? responseLike.data : undefined;
}

function normalizeVideoUrl({
  videoUrl,
  bvid,
  aid,
  pageNo,
}: {
  videoUrl?: unknown;
  bvid?: unknown;
  aid?: unknown;
  pageNo?: unknown;
}): string | undefined {
  const directUrl = String(videoUrl ?? "").trim();
  if (directUrl) {
    return directUrl;
  }

  return buildBiliVideoUrl({ bvid, aid, pageNo }) ?? undefined;
}

function isJsonSafeValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonSafeValue(item));
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.values(value).every((item) => isJsonSafeValue(item));
}
