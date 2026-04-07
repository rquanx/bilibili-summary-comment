import {
  createClient,
  fail,
  getTopComment,
  getType,
  parseArgs,
  printJson,
  readCookie,
  readMessage,
  resolveOid,
  showUsage,
} from './lib/bili-comment-utils.mjs'
import { openDatabase } from './lib/storage.mjs'
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from './lib/video-state.mjs'
import { postSummaryThread } from './lib/comment-thread.mjs'
import { loadDotEnvIfPresent } from './lib/runtime-tools.mjs'

loadDotEnvIfPresent()

function usage() {
  showUsage([
    'Usage:',
    '  node scripts/post-bili-summary.mjs --cookie-file cookie.txt --oid 123 --message-file summary.txt',
    '  node scripts/post-bili-summary.mjs --cookie-file cookie.txt --aid 123 --message "评论内容"',
    '',
    'Options:',
    '  --cookie / --cookie-file   Required. Bilibili cookie string or cookie file path.',
    '  --oid / --aid              Video comment oid. For normal videos this is the aid.',
    '  --bvid / --url             Optional. Resolved through @renmu/bili-api video.info().',
    '  --message / --message-file Required. Comment content.',
    '  --db                       Optional. SQLite path. Default: work/pipeline.sqlite3',
    '  --root-rpid                Optional. Force replies into the specified root comment.',
    '  --type                     Comment type, default 1.',
    '  --help                     Show this help.',
  ])
}

async function main() {
  const args = parseArgs()
  if (args.help) {
    usage()
    return
  }

  const cookie = readCookie(args)
  const message = readMessage(args)

  const client = createClient(cookie)
  const type = getType(args)
  const oid = await resolveOid(client, args)
  const dbPath = args.db ?? 'work/pipeline.sqlite3'
  const db = openDatabase(dbPath)
  const snapshot = await fetchVideoSnapshot(client, args)
  const state = syncVideoSnapshotToDb(db, snapshot)
  const topCommentState = await getTopComment(client, { oid, type })
  const forcedRootRpid = parseOptionalPositiveInteger(args['root-rpid'])
  const result = await postSummaryThread({
    client,
    oid,
    type,
    message,
    db,
    videoId: state.video.id,
    topCommentState,
    existingRootRpid: state.video.root_comment_rpid,
    forcedRootRpid,
  })

  printJson({
    ok: true,
    action: result.action,
    dbPath,
    oid,
    type,
    hasTopComment: topCommentState.hasTopComment,
    rootCommentRpid: result.rootCommentRpid,
    topComment: {
      rpid: topCommentState.topComment?.rpid ?? null,
      uname: topCommentState.topComment?.uname ?? null,
      message: topCommentState.topComment?.message ?? null,
    },
    coveredPagesFromMessage: result.coveredPagesFromMessage,
    createdComments: result.createdComments,
  })
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail('Invalid --root-rpid, expected a positive integer', { received: value })
  }

  return parsed
}

main().catch((error) => {
  printJson({
    ok: false,
    message: error?.message ?? 'Unknown error',
    stack: error?.stack,
  })
  process.exitCode = 1
})
