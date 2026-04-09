import { printErrorJson, printJson } from "./lib/bili-comment-utils.mjs";
import {
  extractBiliAuthState,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "./lib/bili-auth.mjs";
import { createCliCommand, parseCliArgs } from "./lib/cli-tools.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

const command = createCliCommand({
  name: "refresh-bili-cookie",
  description: "Refresh the persisted Bilibili web cookie from TV auth credentials.",
})
  .option("--auth-file <path>", "Optional. TV login payload JSON path.")
  .option("--cookie-file <path>", "Optional. Target cookie text file path.")
  .option("--access-token <token>", "Optional. Override access token from CLI.")
  .option("--refresh-token <token>", "Optional. Override refresh token from CLI.");

async function main() {
  const args = parseCliArgs(command);

  const authFile = resolveBiliAuthFile(args["auth-file"]);
  const cookieFile = resolveBiliCookieFile(args["cookie-file"]);
  const result = await refreshBiliCookie({
    authFile,
    cookieFile,
    accessToken: args["access-token"] ?? null,
    refreshToken: args["refresh-token"] ?? null,
  });
  const authState = extractBiliAuthState(result.bundle);

  printJson({
    ok: true,
    authFile: result.authFile,
    cookieFile: result.cookieFile,
    updatedAt: result.bundle.updatedAt,
    mid: authState.mid,
    cookieNames: result.bundle.cookieInfo.cookies.map((item) => item.name),
  });
}

main().catch((error) => {
  printErrorJson(error);
});
