import { Command, InvalidArgumentError } from "commander";
import type { Command as CommanderCommand } from "commander";
import { z } from "zod";
import { attachVideoContextToError } from "../../domains/bili/video-url";
import { errorToJson } from "./errors";
import { loadDotEnvIfPresent } from "../runtime-tools";

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.coerce.number().int().positive();
const nonNegativeIntegerSchema = z.coerce.number().int().min(0);

export interface CliArgs extends Record<string, unknown> {
  [key: string]: unknown;
}

interface CreateCliCommandOptions {
  name: string;
  description?: string;
}

interface RunCliOptions<TArgs extends CliArgs, TResult> {
  command: CommanderCommand;
  handler: (args: TArgs) => TResult | Promise<TResult>;
  argv?: string[];
  loadEnv?: boolean;
  loadEnvFn?: (envPath?: string) => unknown;
  printResult?: boolean;
  printFn?: (data: TResult) => unknown;
  onError?: (error: unknown) => TResult | undefined | Promise<TResult | undefined>;
}

export function createCliCommand({ name, description = "" }: CreateCliCommandOptions): Command {
  return new Command()
    .name(name)
    .description(description)
    .showHelpAfterError()
    .showSuggestionAfterError()
    .allowExcessArguments(false);
}

export function addCookieOptions(command: Command, { required = false }: { required?: boolean } = {}): Command {
  const optionText = required ? "Required." : "Optional.";
  return command
    .option("--cookie <cookie>", `${optionText} Bilibili cookie string.`)
    .option("--cookie-file <path>", `${optionText} Bilibili cookie file path.`)
    .option("--auth-file <path>", `${optionText} Bilibili auth JSON path.`);
}

export function addVideoIdentityOptions(command: Command): Command {
  return command
    .option("--oid <oid>", "Optional. Video oid.")
    .option("--aid <aid>", "Optional. Video aid.")
    .option("--bvid <bvid>", "Optional. Bilibili BV id.")
    .option("--url <url>", "Optional. Video URL.");
}

export function addDatabaseOption(command: Command, defaultValue = "work/pipeline.sqlite3"): Command {
  return command.option("--db <path>", `Optional. SQLite path. Default: ${defaultValue}`);
}

export function addWorkRootOption(command: Command, defaultValue = "work"): Command {
  return command.option("--work-root <path>", `Optional. Work root. Default: ${defaultValue}`);
}

export function addCommentTypeOption(command: Command): Command {
  return command.option("--type <type>", "Optional. Comment type, default 1.", parsePositiveIntegerArg);
}

export function addSummaryApiOptions(command: Command): Command {
  return command
    .option("--model <model>", "Optional. Summary model override.")
    .option("--api-key <key>", "Optional. Summary API key override.")
    .option("--api-base-url <url>", "Optional. Summary API base URL override.")
    .option("--api-format <format>", "Optional. Summary API format override.")
    .option("--prompt-config <path>", "Optional. Summary prompt config path override.");
}

export function addMessageOptions(command: Command): Command {
  return command
    .option("--message <text>", "Required. Comment content.")
    .option("--message-file <path>", "Required. Comment content file path.");
}

export function parseCliArgs(command: CommanderCommand, argv = process.argv): CliArgs {
  command.parse(argv);
  return normalizeCommanderOptions(command.opts());
}

export async function runCli<TArgs extends CliArgs = CliArgs, TResult = unknown>({
  command,
  handler,
  argv = process.argv,
  loadEnv = true,
  loadEnvFn = loadDotEnvIfPresent,
  printResult = true,
  printFn = defaultPrintJson,
  onError = defaultCliErrorHandler,
}: RunCliOptions<TArgs, TResult>): Promise<TResult | undefined> {
  let parsedArgs: TArgs | null = null;
  try {
    if (loadEnv) {
      await loadEnvFn();
    }

    const args = parseCliArgs(command, argv) as TArgs;
    parsedArgs = args;
    const result = await handler(args);
    if (printResult && result !== undefined) {
      await printFn(result);
    }
    return result;
  } catch (error) {
    attachVideoContextToError(error, {
      bvid: parsedArgs?.bvid ?? null,
      aid: parsedArgs?.aid ?? parsedArgs?.oid ?? null,
    });
    return await onError(error);
  }
}

export function parsePositiveIntegerArg(value: string): number {
  return parseArgWithSchema(positiveIntegerSchema, value, "Expected a positive integer");
}

export function parseNonNegativeIntegerArg(value: string): number {
  return parseArgWithSchema(nonNegativeIntegerSchema, value, "Expected a non-negative integer");
}

export function parseOptionalPositiveInteger(value: unknown, fieldName = "value"): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return parseArgWithSchema(positiveIntegerSchema, value, `Invalid ${fieldName}, expected a positive integer`);
}

export function requireNonEmptyString(value: unknown, fieldName: string): string {
  try {
    return nonEmptyStringSchema.parse(value);
  } catch {
    throw new Error(`Missing required option: ${fieldName}`);
  }
}

function normalizeCommanderOptions(options: Record<string, unknown>): CliArgs {
  const normalized: CliArgs = {};

  for (const [key, value] of Object.entries(options)) {
    normalized[key] = value;
    normalized[camelToKebab(key)] = value;
  }

  return normalized;
}

function camelToKebab(value: unknown): string {
  return String(value ?? "").replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function parseArgWithSchema<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new InvalidArgumentError(message);
  }
}

function defaultPrintJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function defaultCliErrorHandler(error: unknown) {
  defaultPrintJson(errorToJson(error));
  process.exitCode = 1;
  return undefined;
}
