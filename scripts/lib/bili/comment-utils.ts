import fs from "node:fs";
import { Client } from "@renmu/bili-api";
import { createCliError, errorToJson } from "../cli/errors.js";

interface CommentArgs extends Record<string, unknown> {
  cookie?: unknown;
  "cookie-file"?: unknown;
  message?: unknown;
  "message-file"?: unknown;
  type?: unknown;
  oid?: unknown;
  aid?: unknown;
  bvid?: unknown;
  url?: unknown;
}

interface ParsedCookie {
  bili_jct: string;
  SESSDATA: string;
  DedeUserID: string | number;
  [key: string]: string | number;
}

interface TopCommentReply {
  rpid: number;
  oid: unknown;
  mid: unknown;
  uname: string | null;
  message: string;
  like: unknown;
  count: unknown;
  ctime: unknown;
  raw: Record<string, unknown>;
}

interface OidResolverClient {
  video?: {
    info: (params: { bvid: string }) => Promise<{ aid?: unknown } | null | undefined>;
  };
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function printErrorJson(error: unknown, fallbackMessage = "Unknown error") {
  printJson(errorToJson(error, fallbackMessage));
  process.exitCode = 1;
}

export function readCookie(args: CommentArgs): string {
  if (typeof args.cookie === "string" && args.cookie.trim()) {
    return args.cookie.trim();
  }

  if (typeof args["cookie-file"] === "string" && args["cookie-file"].trim()) {
    return readTextFile(args["cookie-file"]).trim();
  }

  throw createCliError("Missing required option: --cookie or --cookie-file");
}

export function readMessage(args: CommentArgs): string {
  if (typeof args.message === "string") {
    return args.message.trim();
  }

  if (typeof args["message-file"] === "string" && args["message-file"].trim()) {
    return readTextFile(args["message-file"]).trim();
  }

  throw createCliError("Missing required option: --message or --message-file");
}

export function createClient(cookie: string | null): Client {
  const client = new Client();
  if (cookie) {
    const parsedCookie = parseCookieString(cookie);
    const uid = Number(parsedCookie.DedeUserID);
    if (Number.isInteger(uid) && uid > 0) {
      void client.setAuth(parsedCookie, uid);
    }
  }
  return client;
}

export function getType(args: CommentArgs): number {
  const value = args.type ?? "1";
  const type = Number(value);
  if (!Number.isInteger(type) || type <= 0) {
    throw createCliError("Invalid --type, expected a positive integer", { received: value });
  }
  return type;
}

export async function resolveOid(client: OidResolverClient, args: CommentArgs): Promise<number> {
  const directValue = args.oid ?? args.aid;
  if (directValue !== undefined) {
    const oid = Number(directValue);
    if (!Number.isInteger(oid) || oid <= 0) {
      throw createCliError("Invalid --oid/--aid, expected a positive integer", {
        received: directValue,
      });
    }
    return oid;
  }

  const bvid = getBvid(args);
  if (!bvid) {
    throw createCliError("Missing required option: one of --oid, --aid, --bvid, --url");
  }

  const info = await client.video?.info({ bvid });
  const oid = Number(info?.aid);
  if (!Number.isInteger(oid) || oid <= 0) {
    throw createCliError("Failed to resolve oid from bvid", { bvid, info });
  }
  return oid;
}

export function getBvid(args: CommentArgs): string | null {
  if (typeof args.bvid === "string" && args.bvid.trim()) {
    return args.bvid.trim();
  }

  if (typeof args.url === "string" && args.url.trim()) {
    return extractBvidFromUrl(args.url.trim());
  }

  return null;
}

function extractBvidFromUrl(url: string): string | null {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+)/i) ?? url.match(/\b(BV[0-9A-Za-z]+)\b/i);
  return match?.[1] ?? null;
}

function parseCookieString(cookie: string): ParsedCookie {
  const cookieObject = {} as ParsedCookie;

  for (const pair of cookie.split(";")) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) {
      continue;
    }

    const separatorIndex = trimmedPair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedPair.slice(0, separatorIndex).trim();
    const value = trimmedPair.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    cookieObject[key] = value;
  }

  return cookieObject;
}

export async function getTopComment(client: Client, { oid, type }: { oid: number; type: number }) {
  type ReplyListParams = Parameters<Client["reply"]["list"]>[0];
  const response = await client.reply.list({
    oid,
    type,
    pn: 1,
    ps: 20 as unknown as ReplyListParams["ps"],
    sort: 0,
    nohot: 0,
  });
  const safeResponse = (typeof response === "object" && response !== null ? response : {}) as Record<string, unknown>;
  const upper = (typeof safeResponse.upper === "object" && safeResponse.upper !== null
    ? safeResponse.upper
    : {}) as Record<string, unknown>;

  const topReply = normalizeTopReply(upper.top) ?? normalizeTopReply(safeResponse.top);

  return {
    oid,
    type,
    hasTopComment: Boolean(topReply),
    topComment: topReply,
    raw: response,
  };
}

function normalizeTopReply(reply: unknown): TopCommentReply | null {
  if (!reply || typeof reply !== "object") {
    return null;
  }

  const safeReply = reply as Record<string, unknown>;
  const member = (typeof safeReply.member === "object" && safeReply.member !== null
    ? safeReply.member
    : {}) as Record<string, unknown>;
  const content = (typeof safeReply.content === "object" && safeReply.content !== null
    ? safeReply.content
    : {}) as Record<string, unknown>;

  const rpid = Number(safeReply.rpid ?? safeReply.rpid_str ?? 0);
  if (!Number.isInteger(rpid) || rpid <= 0) {
    return null;
  }

  return {
    rpid,
    oid: safeReply.oid ?? null,
    mid: safeReply.mid ?? member.mid ?? null,
    uname: typeof member.uname === "string" ? member.uname : null,
    message: typeof content.message === "string" ? content.message : "",
    like: safeReply.like ?? 0,
    count: safeReply.count ?? 0,
    ctime: safeReply.ctime ?? null,
    raw: safeReply,
  };
}
