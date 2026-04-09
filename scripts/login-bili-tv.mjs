import { TvQrcodeLogin } from "@renmu/bili-api";
import { printErrorJson, printJson } from "./lib/bili-comment-utils.mjs";
import { saveBiliAuthBundle, resolveBiliAuthFile, resolveBiliCookieFile } from "./lib/bili-auth.mjs";
import { createCliCommand, parseCliArgs } from "./lib/cli-tools.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

const command = createCliCommand({
  name: "login-bili-tv",
  description: "Log in to Bilibili TV via QR code and persist auth artifacts.",
})
  .option("--auth-file <path>", "Optional. Where to save the TV login payload.")
  .option("--cookie-file <path>", "Optional. Where to save the refreshed web cookie string.");

async function main() {
  const args = parseCliArgs(command);

  const authFile = resolveBiliAuthFile(args["auth-file"]);
  const cookieFile = resolveBiliCookieFile(args["cookie-file"]);
  const client = new TvQrcodeLogin();

  client.on("scan", () => {
    process.stderr.write("[bili-login] QR code scanned, waiting for confirmation\n");
  });
  client.on("error", (response) => {
    process.stderr.write(`[bili-login] login failed: ${response?.message ?? "unknown error"}\n`);
  });

  const completionPromise = waitForLoginCompletion(client);
  const url = await client.login();

  process.stderr.write("[bili-login] Open the URL below as a QR code and scan it with the Bilibili app:\n");
  process.stderr.write(`${url}\n`);

  const rawData = await completionPromise;
  const saved = saveBiliAuthBundle({
    rawData,
    source: "tv_qrcode_login",
    authFile,
    cookieFile,
  });

  printJson({
    ok: true,
    authFile: saved.authFile,
    cookieFile: saved.cookieFile,
    updatedAt: saved.bundle.updatedAt,
    mid: saved.bundle.tokenInfo.mid,
  });
}

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

main().catch((error) => {
  printErrorJson(error);
});
