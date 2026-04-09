import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.coerce.number().int().positive();
const nonNegativeIntegerSchema = z.coerce.number().int().min(0);

export function createCliCommand({ name, description = "" }) {
  return new Command()
    .name(name)
    .description(description)
    .showHelpAfterError()
    .showSuggestionAfterError()
    .allowExcessArguments(false);
}

export function addCookieOptions(command, { required = false } = {}) {
  const optionText = required ? "Required." : "Optional.";
  return command
    .option("--cookie <cookie>", `${optionText} Bilibili cookie string.`)
    .option("--cookie-file <path>", `${optionText} Bilibili cookie file path.`);
}

export function addVideoIdentityOptions(command) {
  return command
    .option("--oid <oid>", "Optional. Video oid.")
    .option("--aid <aid>", "Optional. Video aid.")
    .option("--bvid <bvid>", "Optional. Bilibili BV id.")
    .option("--url <url>", "Optional. Video URL.");
}

export function addDatabaseOption(command, defaultValue = "work/pipeline.sqlite3") {
  return command.option("--db <path>", `Optional. SQLite path. Default: ${defaultValue}`);
}

export function addWorkRootOption(command, defaultValue = "work") {
  return command.option("--work-root <path>", `Optional. Work root. Default: ${defaultValue}`);
}

export function addCommentTypeOption(command) {
  return command.option("--type <type>", "Optional. Comment type, default 1.", parsePositiveIntegerArg);
}

export function addSummaryApiOptions(command) {
  return command
    .option("--model <model>", "Optional. Summary model override.")
    .option("--api-key <key>", "Optional. Summary API key override.")
    .option("--api-base-url <url>", "Optional. Summary API base URL override.")
    .option("--api-format <format>", "Optional. Summary API format override.");
}

export function addMessageOptions(command) {
  return command
    .option("--message <text>", "Required. Comment content.")
    .option("--message-file <path>", "Required. Comment content file path.");
}

export function parseCliArgs(command, argv = process.argv) {
  command.parse(argv);
  return normalizeCommanderOptions(command.opts());
}

export function parsePositiveIntegerArg(value) {
  return parseArgWithSchema(positiveIntegerSchema, value, "Expected a positive integer");
}

export function parseNonNegativeIntegerArg(value) {
  return parseArgWithSchema(nonNegativeIntegerSchema, value, "Expected a non-negative integer");
}

export function parseOptionalPositiveInteger(value, fieldName = "value") {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return parseArgWithSchema(positiveIntegerSchema, value, `Invalid ${fieldName}, expected a positive integer`);
}

export function requireNonEmptyString(value, fieldName) {
  try {
    return nonEmptyStringSchema.parse(value);
  } catch {
    throw new Error(`Missing required option: ${fieldName}`);
  }
}

function normalizeCommanderOptions(options) {
  const normalized = {};

  for (const [key, value] of Object.entries(options)) {
    normalized[key] = value;
    normalized[camelToKebab(key)] = value;
  }

  return normalized;
}

function camelToKebab(value) {
  return String(value ?? "").replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function parseArgWithSchema(schema, value, message) {
  try {
    return schema.parse(value);
  } catch {
    throw new InvalidArgumentError(message);
  }
}
