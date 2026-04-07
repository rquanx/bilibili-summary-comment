import { fail } from "./bili-comment-utils.mjs";
import { extractCoveredPages, normalizeSummaryMarkers, splitSummaryForComments } from "./summary-format.mjs";
import { markPartsPublished, updateVideoCommentThread } from "./storage.mjs";

const sleep = (timeout) =>
  new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });

const DELETED_COMMENT_PATTERNS = [
  "\u5df2\u7ecf\u88ab\u5220\u9664",
  "\u5df2\u88ab\u5220\u9664",
  "\u8bc4\u8bba\u4e0d\u5b58\u5728",
  "\u8be5\u8bc4\u8bba\u4e0d\u5b58\u5728",
  "\u6839\u8bc4\u8bba\u4e0d\u5b58\u5728",
  "\u697c\u5c42\u4e0d\u5b58\u5728",
];

function getCommentErrorMessages(error) {
  const values = [
    error?.message,
    error?.rawResponse?.data?.message,
    error?.rawResponse?.data?.msg,
  ];

  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function isDeletedCommentThreadError(error) {
  const messages = getCommentErrorMessages(error);
  return messages.some((message) => DELETED_COMMENT_PATTERNS.some((pattern) => message.includes(pattern)));
}

function buildCreatedCommentRecord({ replyRes, rootRpid, chunk, isRoot }) {
  return {
    rpid: replyRes.rpid,
    root: rootRpid,
    parent: rootRpid,
    pages: chunk.pages,
    messageLength: chunk.message.length,
    isRoot,
  };
}

async function createRootComment({ client, oid, type, chunk }) {
  const rootRes = await client.reply.add({
    oid,
    type,
    message: chunk.message,
    plat: 1,
  });

  await sleep(1000);
  await client.reply.top({
    oid,
    type,
    rpid: rootRes.rpid,
    action: 1,
  });

  return rootRes;
}

export async function postSummaryThread({
  client,
  oid,
  type,
  message,
  db,
  videoId,
  topCommentState,
  existingRootRpid = null,
  forcedRootRpid = null,
}) {
  const normalizedMessage = normalizeSummaryMarkers(message);
  if (!normalizedMessage) {
    fail("Comment content is empty");
  }

  const chunks = splitSummaryForComments(normalizedMessage, 1000);
  if (chunks.length === 0) {
    fail("No comment chunks generated from summary");
  }

  let rootRpid = forcedRootRpid ?? existingRootRpid ?? topCommentState.topComment?.rpid ?? null;
  const createdComments = [];
  let recoveredFromDeletedRoot = false;
  let replacedRootCommentRpid = null;

  if (!rootRpid) {
    const firstChunk = chunks.shift();
    const rootRes = await createRootComment({
      client,
      oid,
      type,
      chunk: firstChunk,
    });

    rootRpid = rootRes.rpid;
    createdComments.push(
      buildCreatedCommentRecord({
        replyRes: rootRes,
        rootRpid: rootRes.rpid,
        chunk: firstChunk,
        isRoot: true,
      }),
    );
  } else if (!topCommentState.hasTopComment || topCommentState.topComment?.rpid !== rootRpid) {
    await client.reply
      .top({
        oid,
        type,
        rpid: rootRpid,
        action: 1,
      })
      .catch(() => null);
  }

  for (const chunk of chunks) {
    try {
      const replyRes = await client.reply.add({
        oid,
        type,
        root: rootRpid,
        parent: rootRpid,
        message: chunk.message,
        plat: 1,
      });

      createdComments.push(
        buildCreatedCommentRecord({
          replyRes,
          rootRpid,
          chunk,
          isRoot: false,
        }),
      );
    } catch (error) {
      if (createdComments.length === 0 && rootRpid && isDeletedCommentThreadError(error)) {
        const rootRes = await createRootComment({
          client,
          oid,
          type,
          chunk,
        });

        replacedRootCommentRpid = rootRpid;
        rootRpid = rootRes.rpid;
        recoveredFromDeletedRoot = true;
        createdComments.push(
          buildCreatedCommentRecord({
            replyRes: rootRes,
            rootRpid,
            chunk,
            isRoot: true,
          }),
        );
        continue;
      }

      throw error;
    }
  }

  updateVideoCommentThread(db, videoId, {
    rootCommentRpid: rootRpid,
    topCommentRpid: rootRpid,
  });

  const coveredPages = [...new Set(createdComments.flatMap((item) => item.pages))].sort((a, b) => a - b);
  if (coveredPages.length > 0) {
    markPartsPublished(db, videoId, coveredPages, rootRpid);
  }

  return {
    action: createdComments.some((item) => item.isRoot) ? "comment-thread-created-or-extended" : "reply-to-comment-thread",
    normalizedMessage,
    coveredPagesFromMessage: extractCoveredPages(normalizedMessage),
    rootCommentRpid: rootRpid,
    recoveredFromDeletedRoot,
    replacedRootCommentRpid,
    createdComments,
  };
}
