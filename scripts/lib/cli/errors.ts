export type CliErrorDetails = Record<string, unknown>;

export interface ErrorJson extends Record<string, unknown> {
  ok: false;
  message: string;
  stack?: string;
}

interface ErrorLike {
  message?: unknown;
  stack?: unknown;
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

  if (error instanceof CliError) {
    Object.assign(payload, error.details);
  }

  if (typeof errorLike.stack === "string" && errorLike.stack) {
    payload.stack = errorLike.stack;
  }

  return payload;
}

function normalizeDetails(details: CliErrorDetails): CliErrorDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
}
