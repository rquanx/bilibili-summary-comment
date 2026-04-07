import { fail, parseArgs, printJson, showUsage } from "./lib/bili-comment-utils.mjs";
import {
  extractBiliAuthState,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "./lib/bili-auth.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/refresh-bili-cookie.mjs [--auth-file work/bili-auth.json] [--cookie-file cookie.txt]",
    "  node scripts/refresh-bili-cookie.mjs --access-token <token> --refresh-token <token>",
    "",
    "Options:",
    "  --auth-file               Optional. TV login payload json path. Default: work/bili-auth.json",
    "  --cookie-file             Optional. Target cookie text file path. Default: cookie.txt",
    "  --access-token            Optional. Override access_token from CLI.",
    "  --refresh-token           Optional. Override refresh_token from CLI.",
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
  fail(error?.message ?? "Unknown error", {
    stack: error?.stack,
  });
});
