import { TvQrcodeLogin } from "@renmu/bili-api";
import { fail, parseArgs, printJson, showUsage } from "./lib/bili-comment-utils.mjs";
import { saveBiliAuthBundle, resolveBiliAuthFile, resolveBiliCookieFile } from "./lib/bili-auth.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/login-bili-tv.mjs [--auth-file bili-auth.json] [--cookie-file cookie.txt]",
    "",
    "Options:",
    "  --auth-file               Optional. Where to save the TV login payload. Default: bili-auth.json",
    "  --cookie-file             Optional. Where to save the refreshed web cookie string. Default: cookie.txt",
    "  --help                    Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

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
  fail(error?.message ?? "Unknown error", {
    stack: error?.stack,
  });
});
