import {
  createClient,
  getTopComment,
  getType,
  readCookie,
  resolveOid,
} from "../lib/bili/comment-utils";
import {
  addCommentTypeOption,
  addCookieOptions,
  addVideoIdentityOptions,
  createCliCommand,
  runCli,
} from "../lib/cli/tools";

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

await runCli({
  command,
  loadEnv: false,
  async handler(args) {
    const cookie = readCookie(args);
    const client = createClient(cookie);
    const type = getType(args);
    const oid = await resolveOid(client, args);
    const result = await getTopComment(client, { oid, type });

    return {
      ok: true,
      oid,
      type,
      hasTopComment: result.hasTopComment,
      topComment: result.topComment,
    };
  },
});
