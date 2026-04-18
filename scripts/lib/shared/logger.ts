import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "./runtime-tools";

export type LogLevel = "debug" | "info" | "warn" | "error" | "progress";
export type LogContext = Record<string, unknown>;

export interface FileLogger {
  filePath: string;
  child(context: LogContext): FileLogger;
  log(level: LogLevel, message: string, details?: LogContext): void;
  debug(message: string, details?: LogContext): void;
  info(message: string, details?: LogContext): void;
  warn(message: string, details?: LogContext): void;
  error(message: string, details?: LogContext): void;
  progress(message: string, details?: LogContext): void;
  createStream(details?: LogContext & { level?: LogLevel }): Pick<NodeJS.WritableStream, "write">;
}

interface CreateWorkFileLoggerOptions {
  workRoot?: string;
  name: string;
  label?: string | null;
  day?: string | null;
  group?: string | null;
  context?: LogContext;
  repoRoot?: string;
}

interface LoggerEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
}

export function createWorkFileLogger({
  workRoot = "work",
  name,
  label = null,
  day = null,
  group = null,
  context = {},
  repoRoot = getRepoRoot(),
}: CreateWorkFileLoggerOptions): FileLogger {
  const logDay = normalizeLogDay(day) ?? formatLogDay();
  const logRoot = path.join(repoRoot, workRoot, "logs", logDay);
  const logGroup = sanitizeFilenamePart(group);
  const logDir = logGroup ? path.join(logRoot, logGroup) : logRoot;
  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = formatLogTimestamp();
  const filenameParts = [timestamp, sanitizeFilenamePart(name), sanitizeFilenamePart(label)].filter(Boolean).reverse();
  const filePath = path.join(logDir, `${filenameParts.join("-")}.jsonl`);
  const stream = fs.createWriteStream(filePath, {
    flags: "a",
    encoding: "utf8",
  });

  return createFileLogger({
    filePath,
    stream,
    context,
  });
}

export function createCompositeWriteStream(
  ...streams: Array<Pick<NodeJS.WritableStream, "write"> | null | undefined>
): Pick<NodeJS.WritableStream, "write"> {
  const activeStreams = streams.filter(Boolean);
  return {
    write(chunk) {
      for (const stream of activeStreams) {
        stream.write(chunk);
      }
      return true;
    },
  };
}

export function formatLogDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function createLogGroupName(name: string, label: string | null = null, date = new Date()): string {
  const groupParts = [formatLogTimestamp(date), sanitizeFilenamePart(name), sanitizeFilenamePart(label)].filter(Boolean);
  return groupParts.join("-");
}

function createFileLogger({
  filePath,
  stream,
  context,
}: {
  filePath: string;
  stream: fs.WriteStream;
  context: LogContext;
}): FileLogger {
  const baseContext = normalizeContext(context);

  function writeEntry(level: LogLevel, message: string, details?: LogContext) {
    const entry: LoggerEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    const mergedContext = normalizeContext({
      ...baseContext,
      ...(details ?? {}),
    });
    if (Object.keys(mergedContext).length > 0) {
      entry.context = mergedContext;
    }

    stream.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    filePath,
    child(childContext) {
      return createFileLogger({
        filePath,
        stream,
        context: {
          ...baseContext,
          ...normalizeContext(childContext),
        },
      });
    },
    log(level, message, details) {
      writeEntry(level, message, details);
    },
    debug(message, details) {
      writeEntry("debug", message, details);
    },
    info(message, details) {
      writeEntry("info", message, details);
    },
    warn(message, details) {
      writeEntry("warn", message, details);
    },
    error(message, details) {
      writeEntry("error", message, details);
    },
    progress(message, details) {
      writeEntry("progress", message, details);
    },
    createStream(details = {}) {
      const { level = "debug", ...streamContext } = details;
      return {
        write(chunk) {
          const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
          if (!text) {
            return true;
          }

          writeEntry(level, "stream-output", {
            ...streamContext,
            chunk: text,
          });
          return true;
        },
      };
    },
  };
}

function sanitizeFilenamePart(value: unknown): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 80);
}

function formatLogTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizeLogDay(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeContext(value: unknown): LogContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  try {
    return JSON.parse(JSON.stringify(value, createSafeLogReplacer())) as LogContext;
  } catch {
    return {
      serializationError: "Unable to serialize log context",
    };
  }
}

function createSafeLogReplacer() {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value && typeof value === "object") {
      if (seen.has(value as object)) {
        return "[Circular]";
      }

      seen.add(value as object);
    }

    return value;
  };
}
