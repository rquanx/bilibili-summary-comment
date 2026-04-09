import {
  extractBiliAuthState,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "./lib/bili-auth.mjs";
import { createCliCommand, runCli } from "./lib/cli-tools.mjs";

const command = createCliCommand({
  name: "refresh-bili-cookie",
  description: "Refresh the persisted Bilibili web cookie from TV auth credentials.",
})
  .option("--auth-file <path>", "Optional. TV login payload JSON path.")
  .option("--cookie-file <path>", "Optional. Target cookie text file path.")
  .option("--access-token <token>", "Optional. Override access token from CLI.")
  .option("--refresh-token <token>", "Optional. Override refresh token from CLI.");

await runCli({
  command,
  async handler(args) {
    const authFile = resolveBiliAuthFile(args["auth-file"]);
    const cookieFile = resolveBiliCookieFile(args["cookie-file"]);
    const result = await refreshBiliCookie({
      authFile,
      cookieFile,
      accessToken: args["access-token"] ?? null,
      refreshToken: args["refresh-token"] ?? null,
    });
    const authState = extractBiliAuthState(result.bundle);

    return {
      ok: true,
      authFile: result.authFile,
      cookieFile: result.cookieFile,
      updatedAt: result.bundle.updatedAt,
      mid: authState.mid,
      cookieNames: result.bundle.cookieInfo.cookies.map((item) => item.name),
    };
  },
});
