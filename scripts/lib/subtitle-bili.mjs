import fs from "node:fs";

export async function tryDownloadBiliSubtitle({ client, bvid, cid, subtitlePath, cookie }) {
  const playerInfo = await client.video.playerInfo({ bvid, cid });
  const subtitles = playerInfo?.subtitle?.subtitles ?? [];
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    return null;
  }

  const picked = subtitles.find((item) => Number(item.ai_type ?? 0) > 0 || Number(item.ai_status ?? 0) > 0) ?? subtitles[0];
  const subtitleUrl = normalizeSubtitleUrl(picked.subtitle_url_v2 ?? picked.subtitle_url);
  if (!subtitleUrl) {
    return null;
  }

  const response = await fetch(subtitleUrl, {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: `https://www.bilibili.com/video/${bvid}`,
      ...(cookie ? { cookie } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Bilibili subtitle: ${response.status} ${response.statusText}`);
  }

  const subtitleJson = await response.json();
  const srtText = convertBiliSubtitleJsonToSrt(subtitleJson);
  if (!srtText.trim()) {
    return null;
  }

  fs.writeFileSync(subtitlePath, `${srtText.trim()}\n`, "utf8");
  return {
    source: Number(picked.ai_type ?? 0) > 0 || Number(picked.ai_status ?? 0) > 0 ? "bili_ai" : "bili_subtitle",
    lang: picked.lan ?? null,
  };
}

function normalizeSubtitleUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    return null;
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  return `https://${url.replace(/^\/+/, "")}`;
}

function convertBiliSubtitleJsonToSrt(data) {
  const body = Array.isArray(data?.body) ? data.body : [];
  const lines = [];
  let index = 1;

  for (const item of body) {
    const from = Number(item?.from);
    const to = Number(item?.to);
    const content = String(item?.content ?? "").trim();

    if (!Number.isFinite(from) || !Number.isFinite(to) || !content) {
      continue;
    }

    lines.push(String(index));
    lines.push(`${formatSrtTimestamp(from)} --> ${formatSrtTimestamp(to)}`);
    lines.push(content);
    lines.push("");
    index += 1;
  }

  return lines.join("\n");
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}
