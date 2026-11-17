import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uploadTextToPaste } from "../../../src/domains/bili/paste-upload";

const folder = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.resolve(folder, "../../../work/元宝录像小屋/啵玲_BoBa2026.11.10-22.35__BV1CvWg6aEEh/paste-p02.txt");
const text = fs.existsSync(samplePath) ? fs.readFileSync(samplePath, "utf8") : "<2P>\n2#01:08 开播闲聊与近况分享\n2#02:10 连麦交流 VR 设备，讨论入门方案与实际体验。\n2#04:42 分享新模型的制作进展，以及下一阶段的直播计划。";
process.env.PRIVATEBIN_URL = "https://local-preview.invalid";
let encrypted;
const share = await uploadTextToPaste(text, (async (_url, options) => {
  encrypted = JSON.parse(String(options.body));
  return Response.json({ status: 0, id: "1234567890abcdef" });
}) as typeof fetch);
const fragment = new URL(share).hash;
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4318");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (url.pathname === "/") { res.writeHead(302, { Location: `/read?1234567890abcdef${fragment}` }); res.end(); return; }
  if (url.pathname === "/api/paste") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(encrypted)); return; }
  const file = ({ "/read": "index.html", "/reader.css": "reader.css", "/reader.js": "reader.js" })[url.pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", mime[path.extname(file)]);
  fs.createReadStream(path.join(folder, file)).pipe(res);
});
server.listen(4318, "127.0.0.1", () => console.log("Reader preview: http://127.0.0.1:4318 (local encrypted sample; no production requests)"));
