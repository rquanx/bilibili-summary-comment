import { TvQrcodeLogin } from "@renmu/bili-api";
import qrcodeTerminal from "qrcode-terminal";
import { resolveBiliLoginOutputFiles, saveBiliAuthBundle } from "../lib/bili/auth";
import { createCliCommand, runCli } from "../lib/cli/tools";

const command = createCliCommand({
  name: "login-bili-tv",
  description: "Log in to Bilibili TV via QR code and persist auth artifacts.",
})
  .option("--auth-file <path>", "Optional. Where to save the TV login payload.")
  .option("--cookie-file <path>", "Optional. Where to save the refreshed web cookie string.");

await runCli({
  command,
  async handler(args) {
    const outputFiles = resolveBiliLoginOutputFiles({
      authFile: typeof args["auth-file"] === "string" ? args["auth-file"] : null,
      cookieFile: typeof args["cookie-file"] === "string" ? args["cookie-file"] : null,
    });
    const authFile = outputFiles.authFile;
    const cookieFile = outputFiles.cookieFile;
    const client = new TvQrcodeLogin();

    client.on("scan", () => {
      process.stderr.write("[bili-login] QR code scanned, waiting for confirmation\n");
    });
    client.on("error", (response) => {
      process.stderr.write(`[bili-login] login failed: ${response?.message ?? "unknown error"}\n`);
    });

    const completionPromise = waitForLoginCompletion(client);
    const url = await client.login();

    process.stderr.write(`[bili-login] Will save auth to: ${authFile}\n`);
    if (cookieFile) {
      process.stderr.write(`[bili-login] Will save cookie to: ${cookieFile}\n`);
    }
    process.stderr.write("[bili-login] Scan the QR code below with the Bilibili app:\n\n");
    renderTerminalQr(url);
    process.stderr.write("\n");
    process.stderr.write("[bili-login] If the QR code does not render clearly, open the URL below as a fallback:\n");
    process.stderr.write(`${url}\n`);

    const rawData = await completionPromise;
    const saved = saveBiliAuthBundle({
      rawData,
      source: "tv_qrcode_login",
      authFile,
      cookieFile,
    });

    return {
      ok: true,
      authFile: saved.authFile,
      cookieFile: saved.cookieFile,
      updatedAt: saved.bundle.updatedAt,
      mid: saved.bundle.tokenInfo.mid,
    };
  },
});

function waitForLoginCompletion(client) {
  return new Promise((resolve, reject) => {
    client.once("completed", (response) => {
      resolve(response?.data ?? response);
    });

    client.once("error", (response) => {
      reject(new Error(response?.message ?? "Bilibili TV login failed"));
    });
  });
}

function renderTerminalQr(content: string) {
  try {
    qrcodeTerminal.generate(content, {
      small: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown error");
    process.stderr.write(`[bili-login] Failed to render terminal QR code: ${message}\n`);
  }
}
