import {
  createClient,
  getTopComment,
  getType,
  parseArgs,
  printJson,
  readCookie,
  resolveOid,
  showUsage,
} from "./lib/bili-comment-utils.mjs";

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/get-bili-top-comment.mjs --cookie-file cookie.txt --oid 123",
    "  node scripts/get-bili-top-comment.mjs --cookie-file cookie.txt --aid 123",
    "",
    "Options:",
    "  --cookie / --cookie-file   Required. Bilibili cookie string or cookie file path.",
    "  --oid / --aid              Video comment oid. For normal videos this is the aid.",
    "  --bvid / --url             Optional. Resolved through @renmu/bili-api video.info().",
    "  --type                     Comment type, default 1.",
    "  --help                     Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const cookie = readCookie(args);
  const client = createClient(cookie);
  const type = getType(args);
  const oid = await resolveOid(client, args);
  const result = await getTopComment(client, { oid, type });

  printJson({
    ok: true,
    oid,
    type,
    hasTopComment: result.hasTopComment,
    topComment: result.topComment,
  });
}

main().catch((error) => {
  printJson({
    ok: false,
    message: error?.message ?? "Unknown error",
    stack: error?.stack,
  });
  process.exitCode = 1;
});
