import { createClient, getType, resolveOid } from "../lib/bili/comment-utils";
import { listGuestTopLevelReplies } from "../lib/bili/comment-thread";
import {
  addCommentTypeOption,
  addVideoIdentityOptions,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools";

const command = addCommentTypeOption(
  addVideoIdentityOptions(
    createCliCommand({
      name: "get-bili-guest-replies",
      description: "Fetch guest-visible top-level Bilibili replies without auth.",
    }),
  ),
)
  .option("--pn <page>", "Optional. Comment page number. Default: 1.", parsePositiveIntegerArg)
  .option("--ps <size>", "Optional. Page size. Default: 20.", parsePositiveIntegerArg);

await runCli({
  command,
  loadEnv: false,
  async handler(args) {
    const resolverClient = createClient(null);
    const type = getType(args);
    const oid = await resolveOid(resolverClient, args);
    const pn = typeof args.pn === "number" ? args.pn : 1;
    const ps = typeof args.ps === "number" ? args.ps : 20;
    const reply = await listGuestTopLevelReplies({
      oid,
      type,
      pn,
      ps,
    });

    return {
      ok: true,
      oid,
      type,
      pn,
      ps,
      reply,
    };
  },
});
