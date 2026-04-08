import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function getRepoRoot() {
  return REPO_ROOT;
}

export function loadDotEnvIfPresent(envPath = path.join(getRepoRoot(), ".env")) {
  if (!fs.existsSync(envPath)) {
    return false;
  }

  const raw = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  return true;
}

export function isWindows() {
  return process.platform === "win32";
}

export function getVenvBinDir(venvPath = ".3.11") {
  return path.join(getRepoRoot(), venvPath, isWindows() ? "Scripts" : "bin");
}

export function getVenvExecutable(name, venvPath = ".3.11") {
  const executableName = isWindows() ? `${name}.exe` : name;
  return path.join(getVenvBinDir(venvPath), executableName);
}

export function getVenvPython(venvPath = ".3.11") {
  return getVenvExecutable("python", venvPath);
}

export async function runVenvModule(moduleName, args = [], options = {}) {
  const { venvPath = ".3.11", ...commandOptions } = options;
  return runCommand(getVenvPython(venvPath), ["-m", moduleName, ...args], commandOptions);
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const outputStream = options.outputStream ?? process.stderr;
    const child = spawn(command, args, {
      cwd: options.cwd ?? getRepoRoot(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let streamedEndsWithNewline = true;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (options.streamOutput && outputStream) {
          outputStream.write(chunk);
          streamedEndsWithNewline = /[\r\n]$/.test(chunk.toString());
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (options.streamOutput && outputStream) {
          outputStream.write(chunk);
          streamedEndsWithNewline = /[\r\n]$/.test(chunk.toString());
        }
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (options.streamOutput && outputStream && !streamedEndsWithNewline) {
        outputStream.write("\n");
      }

      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      const error = new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}
