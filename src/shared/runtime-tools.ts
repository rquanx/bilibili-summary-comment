import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config as loadDotEnvConfig } from "dotenv";
import type { FileLogger, LogContext } from "./logger";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandError extends Error {
  code?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  streamOutput?: boolean;
  outputStream?: Pick<NodeJS.WritableStream, "write"> | null;
  stdoutStream?: Pick<NodeJS.WritableStream, "write"> | null;
  stderrStream?: Pick<NodeJS.WritableStream, "write"> | null;
  logger?: FileLogger | null;
  logContext?: LogContext;
}

export interface RunVenvModuleOptions extends RunCommandOptions {
  venvPath?: string;
}

const NODE_EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

export function getRepoRoot(): string {
  return REPO_ROOT;
}

export function loadDotEnvIfPresent(envPath = path.join(getRepoRoot(), ".env")): boolean {
  if (!fs.existsSync(envPath)) {
    return false;
  }

  loadDotEnvConfig({
    path: envPath,
    override: false,
    quiet: true,
  });

  return true;
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function getVenvBinDir(venvPath = ".3.11"): string {
  return path.join(getRepoRoot(), venvPath, isWindows() ? "Scripts" : "bin");
}

export function getVenvExecutable(name: string, venvPath = ".3.11"): string {
  const executableName = isWindows() ? `${name}.exe` : name;
  return path.join(getVenvBinDir(venvPath), executableName);
}

export function getVenvPython(venvPath = ".3.11"): string {
  return getVenvExecutable("python", venvPath);
}

export async function runVenvModule(
  moduleName: string,
  args: string[] = [],
  options: RunVenvModuleOptions = {},
): Promise<CommandResult> {
  const { venvPath = ".3.11", ...commandOptions } = options;
  return runCommand(getVenvPython(venvPath), ["-m", moduleName, ...args], commandOptions);
}

export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const outputStream = options.outputStream ?? process.stderr;
    const stdoutStream = options.stdoutStream ?? outputStream;
    const stderrStream = options.stderrStream ?? outputStream;
    const logger = options.logger ?? null;
    const logContext = options.logContext ?? {};
    const childEnv = withSuppressedExperimentalWarning({
      ...process.env,
      ...(options.env ?? {}),
    });
    logger?.debug("Starting command", {
      ...logContext,
      command,
      args,
      cwd: options.cwd ?? getRepoRoot(),
    });
    const child = spawn(command, args, {
      cwd: options.cwd ?? getRepoRoot(),
      env: childEnv,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let stdoutEndsWithNewline = true;
    let stderrEndsWithNewline = true;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (options.streamOutput && stdoutStream) {
          stdoutStream.write(chunk);
          stdoutEndsWithNewline = /[\r\n]$/.test(chunk.toString());
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (options.streamOutput && stderrStream) {
          stderrStream.write(chunk);
          stderrEndsWithNewline = /[\r\n]$/.test(chunk.toString());
        }
      });
    }

    child.on("error", (error) => {
      logger?.error("Command process error", {
        ...logContext,
        command,
        args,
        error,
      });
      reject(error);
    });
    child.on("close", (code) => {
      if (options.streamOutput && stdoutStream && !stdoutEndsWithNewline) {
        stdoutStream.write("\n");
      }

      if (options.streamOutput && stderrStream && !stderrEndsWithNewline) {
        stderrStream.write("\n");
      }

      if (code === 0) {
        logger?.info("Command completed", {
          ...logContext,
          command,
          args,
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });
        resolve({ code, stdout, stderr });
        return;
      }

      const error = new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`) as CommandError;
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      logger?.error("Command failed", {
        ...logContext,
        command,
        args,
        code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
      reject(error);
    });
  });
}

export function withSuppressedExperimentalWarning(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const currentNodeOptions = String(env.NODE_OPTIONS ?? "").trim();
  if (
    currentNodeOptions.includes("--no-warnings")
    || currentNodeOptions.includes(NODE_EXPERIMENTAL_WARNING_FLAG)
  ) {
    return env;
  }

  return {
    ...env,
    NODE_OPTIONS: currentNodeOptions
      ? `${currentNodeOptions} ${NODE_EXPERIMENTAL_WARNING_FLAG}`
      : NODE_EXPERIMENTAL_WARNING_FLAG,
  };
}
