import fs from "node:fs";
import { Client } from "@renmu/bili-api";

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const body = token.slice(2);
    if (!body) {
      continue;
    }

    const equalIndex = body.indexOf("=");
    if (equalIndex >= 0) {
      const key = body.slice(0, equalIndex);
      const value = body.slice(equalIndex + 1);
      args[key] = value;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[body] = next;
      i += 1;
      continue;
    }

    args[body] = true;
  }

  return args;
}

export function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

export function fail(message, extra = {}) {
  printJson({
    ok: false,
    message,
    ...extra,
  });
  process.exit(1);
}

export function showUsage(lines) {
  console.log(lines.join("\n"));
}

export function readCookie(args) {
  if (typeof args.cookie === "string" && args.cookie.trim()) {
    return args.cookie.trim();
  }

  if (typeof args["cookie-file"] === "string" && args["cookie-file"].trim()) {
    return readTextFile(args["cookie-file"]).trim();
  }

  fail("Missing required option: --cookie or --cookie-file");
}

export function readMessage(args) {
  if (typeof args.message === "string") {
    return args.message.trim();
  }

  if (typeof args["message-file"] === "string" && args["message-file"].trim()) {
    return readTextFile(args["message-file"]).trim();
  }

  fail("Missing required option: --message or --message-file");
}

export function createClient(cookie) {
  const client = new Client();
  if (cookie) {
    client.setAuth(parseCookieString(cookie));
  }
  return client;
}

export function getType(args) {
  const value = args.type ?? "1";
  const type = Number(value);
  if (!Number.isInteger(type) || type <= 0) {
    fail("Invalid --type, expected a positive integer", { received: value });
  }
  return type;
}

export async function resolveOid(client, args) {
  const directValue = args.oid ?? args.aid;
  if (directValue !== undefined) {
    const oid = Number(directValue);
    if (!Number.isInteger(oid) || oid <= 0) {
      fail("Invalid --oid/--aid, expected a positive integer", {
        received: directValue,
      });
    }
    return oid;
  }

  const bvid = getBvid(args);
  if (!bvid) {
    fail("Missing required option: one of --oid, --aid, --bvid, --url");
  }

  const info = await client.video.info({ bvid });
  const oid = Number(info?.aid);
  if (!Number.isInteger(oid) || oid <= 0) {
    fail("Failed to resolve oid from bvid", { bvid, info });
  }
  return oid;
}

export function getBvid(args) {
  if (typeof args.bvid === "string" && args.bvid.trim()) {
    return args.bvid.trim();
  }

  if (typeof args.url === "string" && args.url.trim()) {
    return extractBvidFromUrl(args.url.trim());
  }

  return null;
}

function extractBvidFromUrl(url) {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+)/i) ?? url.match(/\b(BV[0-9A-Za-z]+)\b/i);
  return match?.[1] ?? null;
}

function parseCookieString(cookie) {
  const cookieObject = {};

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

export async function getTopComment(client, { oid, type }) {
  const response = await client.reply.list({
    oid,
    type,
    pn: 1,
    ps: 20,
    sort: 0,
    nohot: 0,
  });

  const topReply = normalizeTopReply(response?.upper?.top) ?? normalizeTopReply(response?.top);

  return {
    oid,
    type,
    hasTopComment: Boolean(topReply),
    topComment: topReply,
    raw: response,
  };
}

function normalizeTopReply(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }

  const rpid = Number(reply.rpid ?? reply.rpid_str ?? 0);
  if (!Number.isInteger(rpid) || rpid <= 0) {
    return null;
  }

  return {
    rpid,
    oid: reply.oid ?? null,
    mid: reply.mid ?? reply.member?.mid ?? null,
    uname: reply.member?.uname ?? null,
    message: reply.content?.message ?? "",
    like: reply.like ?? 0,
    count: reply.count ?? 0,
    ctime: reply.ctime ?? null,
    raw: reply,
  };
}
