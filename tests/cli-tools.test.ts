import test from "node:test";
import assert from "node:assert/strict";
import { createCliCommand, runCli } from "../scripts/lib/cli/tools.js";
import { CliError } from "../scripts/lib/cli/errors.js";

test("runCli loads env, parses args, and prints JSON result by default", async () => {
  const command = createCliCommand({ name: "demo-cli" })
    .option("--name <value>", "Optional. Name.");

  const calls = [];
  const logs = [];

  const result = await runCli({
    command,
    argv: ["node", "demo-cli", "--name", "alice"],
    loadEnvFn() {
      calls.push("loadEnv");
    },
    printFn(payload) {
      logs.push(payload);
    },
    async handler(args) {
      calls.push("handler");
      return {
        ok: true,
        name: args.name,
      };
    },
  });

  assert.deepEqual(calls, ["loadEnv", "handler"]);
  assert.deepEqual(logs, [{ ok: true, name: "alice" }]);
  assert.deepEqual(result, { ok: true, name: "alice" });
});

test("runCli can skip env loading and suppress result printing", async () => {
  const command = createCliCommand({ name: "demo-cli" });
  let loadEnvCalled = false;
  let printCalled = false;

  const result = await runCli({
    command,
    argv: ["node", "demo-cli"],
    loadEnv: false,
    loadEnvFn() {
      loadEnvCalled = true;
    },
    printResult: false,
    printFn() {
      printCalled = true;
    },
    handler() {
      return { ok: true };
    },
  });

  assert.equal(loadEnvCalled, false);
  assert.equal(printCalled, false);
  assert.deepEqual(result, { ok: true });
});

test("runCli default error handler serializes failures and sets exitCode", async (t) => {
  const command = createCliCommand({ name: "demo-cli" });
  const originalConsoleLog = console.log;
  const originalExitCode = process.exitCode;
  const outputs = [];

  t.after(() => {
    console.log = originalConsoleLog;
    process.exitCode = originalExitCode;
  });

  console.log = (message) => {
    outputs.push(message);
  };
  process.exitCode = undefined;

  const result = await runCli({
    command,
    argv: ["node", "demo-cli"],
    loadEnv: false,
    handler() {
      throw new CliError("Broken", { field: "--name" });
    },
  });

  assert.equal(result, undefined);
  assert.equal(process.exitCode, 1);
  assert.equal(outputs.length, 1);

  const payload = JSON.parse(outputs[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.message, "Broken");
  assert.equal(payload.field, "--name");
});
