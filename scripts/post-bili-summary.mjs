import { createClient, fail, getTopComment, getType, parseArgs, printJson, readCookie, readMessage, resolveOid, showUsage } from './lib/bili-comment-utils.mjs'

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
    '  --type                     Comment type, default 1.',
    '  --help                     Show this help.',
  ])
}

const sleep = (timeout) =>
  new Promise((res, rej) => {
    setTimeout(() => {
      res()
    }, timeout)
  })

async function main() {
  const args = parseArgs()
  if (args.help) {
    usage()
    return
  }

  const cookie = readCookie(args)
  const message = readMessage(args)
  if (!message) {
    fail('Comment content is empty')
  }

  const client = createClient(cookie)
  const type = getType(args)
  const oid = await resolveOid(client, args)
  const topCommentState = await getTopComment(client, { oid, type })

  if (!topCommentState.hasTopComment) {
    const rootRes = await client.reply.add({
      oid,
      type,
      message,
      plat: 1,
    })
    await sleep(1000)
    await client.reply.top({
      oid,
      type,
      rpid: rootRes.rpid,
      action: 1,
    })

    printJson({
      ok: true,
      action: 'comment-and-top',
      oid,
      type,
      hasTopComment: false,
      topCommentRpidBefore: null,
      createdComment: {
        rpid: rootRes.rpid,
        root: rootRes.rpid,
        parent: rootRes.rpid,
      },
    })
    return
  }

  const topRpid = topCommentState.topComment.rpid
  const replyRes = await client.reply.add({
    oid,
    type,
    root: topRpid,
    parent: topRpid,
    message,
    plat: 1,
  })

  printJson({
    ok: true,
    action: 'reply-to-top-comment',
    oid,
    type,
    hasTopComment: true,
    topComment: {
      rpid: topCommentState.topComment.rpid,
      uname: topCommentState.topComment.uname,
      message: topCommentState.topComment.message,
    },
    createdComment: {
      rpid: replyRes.rpid,
      root: topRpid,
      parent: topRpid,
    },
  })
}

main().catch((error) => {
  printJson({
    ok: false,
    message: error?.message ?? 'Unknown error',
    stack: error?.stack,
  })
  process.exitCode = 1
})
