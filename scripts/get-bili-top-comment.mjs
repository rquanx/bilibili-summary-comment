import {
  createClient,
  getTopComment,
  getType,
  printErrorJson,
  printJson,
  readCookie,
  resolveOid,
} from "./lib/bili-comment-utils.mjs";
import {
  addCommentTypeOption,
  addCookieOptions,
  addVideoIdentityOptions,
  createCliCommand,
  parseCliArgs,
} from "./lib/cli-tools.mjs";

const command = addCommentTypeOption(
  addVideoIdentityOptions(
    addCookieOptions(
      createCliCommand({
        name: "get-bili-top-comment",
        description: "Inspect the current pinned Bilibili comment for a video.",
      }),
      { required: true },
    ),
  ),
);

async function main() {
  const args = parseCliArgs(command);

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
  printErrorJson(error);
});
