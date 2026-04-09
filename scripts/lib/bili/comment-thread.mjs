import { createCliError } from "../cli/errors.mjs";
import { extractCoveredPages, normalizeSummaryMarkers, splitSummaryForComments } from "../summary/format.mjs";
import { markPartsPublished, updateVideoCommentThread } from "../db/index.mjs";

const sleep = (timeout) =>
  new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });

const ROOT_TOP_DELAY_MS = 1000;
const REPLY_POST_DELAY_MS = 1500;

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

export function isMissingCommentThreadError(error) {
  return isDeletedCommentThreadError(error);
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

  await sleep(ROOT_TOP_DELAY_MS);
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
    throw createCliError("Comment content is empty");
  }

  const chunks = splitSummaryForComments(normalizedMessage, 1000);
  if (chunks.length === 0) {
    throw createCliError("No comment chunks generated from summary");
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

  for (const [index, chunk] of chunks.entries()) {
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

      // Bilibili child replies can appear out of order when they land too close together.
      // Spacing out posts makes the visible thread order match the summary page order more reliably.
      if (index < chunks.length - 1) {
        await sleep(REPLY_POST_DELAY_MS);
      }
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

export async function deleteSummaryThread({
  client,
  oid,
  type,
  rootRpid,
}) {
  if (!rootRpid) {
    return {
      ok: true,
      deleted: false,
      reason: "missing-root-rpid",
    };
  }

  try {
    await client.reply.delete({
      oid,
      type,
      rpid: rootRpid,
    });

    return {
      ok: true,
      deleted: true,
      rootRpid,
    };
  } catch (error) {
    if (isDeletedCommentThreadError(error)) {
      return {
        ok: true,
        deleted: false,
        rootRpid,
        alreadyMissing: true,
      };
    }

    throw error;
  }
}
