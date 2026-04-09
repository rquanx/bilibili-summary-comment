export class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CliError";
    this.details = normalizeDetails(details);
  }
}

export function createCliError(message, details = {}) {
  return new CliError(message, details);
}

export function errorToJson(error, fallbackMessage = "Unknown error") {
  const payload = {
    ok: false,
    message: error?.message ?? fallbackMessage,
  };

  if (error instanceof CliError) {
    Object.assign(payload, error.details);
  }

  if (error?.stack) {
    payload.stack = error.stack;
  }

  return payload;
}

function normalizeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
}
