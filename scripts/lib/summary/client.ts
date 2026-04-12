import { formatSummaryTime } from "../subtitle/srt-utils";
import { normalizeSummaryApiBaseUrl } from "./config";

export async function requestSummary({
  pageNo,
  partTitle,
  durationSec,
  subtitleText,
  segments,
  model,
  apiKey,
  apiBaseUrl,
  apiFormat,
  fetchImpl = fetch,
}) {
  const { systemPrompt, userPrompt } = buildSummaryPromptInput({
    pageNo,
    partTitle,
    durationSec,
    subtitleText,
    segments,
  });
  const api = resolveSummaryApiTarget(apiBaseUrl, apiFormat);
  const response = await fetchImpl(
    api.endpointUrl,
    buildSummaryHttpRequest({
      apiFormat: api.apiFormat,
      model,
      apiKey,
      systemPrompt,
      userPrompt,
    }),
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Summary request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const data = await response.json();
  const text = extractSummaryText(data, api.apiFormat);
  if (!text.trim()) {
    throw new Error("Summary response did not contain text output.");
  }

  return text.trim();
}

export function buildSummaryPromptInput({ pageNo, partTitle, durationSec, subtitleText, segments }) {
  const systemPrompt = [
    "你是 Bilibili 直播录像分P总结助手，服务对象是错过直播、想快速补课并定位回看时间点的粉丝。",
    "你的任务不是写观后感，而是把当前分P整理成“快速补课 + 快速定位”的中文看点索引。",
    "只输出最终正文，不要解释，不要加代码块，不要加前言或说明。",
    "用户输入是 JSON。优先依据 segments 总结；只有当 segments 为空时，才参考 rawSubtitleTextWhenSegmentParsingFailed。",
    "只能依据提供的字幕和时间信息总结，不要脑补字幕里没有的信息；拿不准时宁可保守概括，也不要硬猜人名、歌名、梗名。",
    "输出规则：",
    `1. 整个输出只对应当前分P，且必须以 <${pageNo}P> 开头。`,
    `2. 如果 segments 为空、只有 1 段，或者整段内容最终只需要 1 句/1 行总结，就直接输出“<${pageNo}P> ${pageNo}#00:00 总结内容”；这里固定使用 ${pageNo}#00:00，方便快速跳转当前分P。`,
    `3. 只有当内容确实适合拆成多行看点索引时，第一行才单独写 <${pageNo}P>，后续每一行都写“${pageNo}#时间 空格 总结”；不要在后续行重复 <${pageNo}P>，也不要把单行总结误写成多行格式。`,
    `4. 多行示例：<${pageNo}P>\n${pageNo}#03:20 连麦聊到某位主播，还唱了一小段歌\n${pageNo}#08:45 开始打PK，最后输了被罚整活`,
    "5. 每个时间标签都必须贴近该行内容真正开始出现的时间点，优先对应相关字幕的第一句；目标是与内容起点的偏差控制在 10 秒内，要多次核查是否有偏离。",
    "6. 多行总结时只能使用字幕里真实存在的时间点，不要凭空编造，也不要把时间随意向前或向后平移；只有单行总结允许固定写 00:00。",
    "7. 如果拿不准某个细节的精确起点，就减少时间点数量、改成更稳妥的概括，不要硬凑一个不准的时间。",
    "8. 每一行都要像“看点索引”，优先保留粉丝最可能想回看的内容：连麦对象、唱了什么、PK/惩罚/整活、游戏或现场动作、重要观点、突发事件、结果。",
    "9. 每个时间点优先写 1 个主看点，最多补 1 个强相关次信息；不要把三四件互不相干的事硬塞进同一行。",
    "10. 语言自然、口语化、信息密度高，直接写发生了什么；不要写“这一段”“这里主要讲”“随后又”等空转描述。",
    "11. 不要大段复述原字幕，不要只写“闲聊”“互动”“继续聊天”这类无法帮助定位的空泛词。",
    "12. 字幕有重复、口癖、语病或 ASR 误识别时，可以整理后再表达；如果人名、歌名、梗名听不准，就改写成保守但通顺的说法。",
    `13. 交付前拿字幕和总结核对至少两遍这几个问题：单行总结必须是“<${pageNo}P> ${pageNo}#00:00 总结内容”；多行总结里每一行都必须是“${pageNo}#时间 空格 总结”，且时间要贴近对应内容开头，不能偏离太远。`,
  ].join("\n");

  const segmentPayload = Array.isArray(segments) && segments.length > 0
    ? segments.map((segment) => ({
        start: formatSummaryTime(segment.startSec),
        end: formatSummaryTime(segment.endSec),
        text: segment.text,
      }))
    : [];

  const userPrompt = JSON.stringify({
    page: pageNo,
    partTitle,
    durationSec,
    subtitleFormat: "srt",
    segments: segmentPayload.length > 0 ? segmentPayload : null,
    rawSubtitleTextWhenSegmentParsingFailed: segmentPayload.length === 0 ? subtitleText : null,
  });

  return {
    systemPrompt,
    userPrompt,
  };
}

export function buildSummaryHttpRequest({ apiFormat, model, apiKey, systemPrompt, userPrompt }) {
  if (apiFormat === "openai-chat") {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    };
  }

  if (apiFormat === "anthropic-messages") {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      }),
    };
  }

  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ],
    }),
  };
}

export function extractSummaryText(data, apiFormat) {
  if (apiFormat === "openai-chat") {
    return extractChatCompletionText(data);
  }

  if (apiFormat === "anthropic-messages") {
    return extractAnthropicMessageText(data);
  }

  return extractResponseText(data);
}

export function resolveSummaryApiTarget(apiBaseUrl, apiFormat) {
  const baseUrl = normalizeSummaryApiBaseUrl(apiBaseUrl);

  if (apiFormat === "auto") {
    if (baseUrl.endsWith("/chat/completions")) {
      return { apiFormat: "openai-chat", endpointUrl: baseUrl };
    }

    if (baseUrl.endsWith("/messages")) {
      return { apiFormat: "anthropic-messages", endpointUrl: baseUrl };
    }

    if (baseUrl.endsWith("/responses")) {
      return { apiFormat: "responses", endpointUrl: baseUrl };
    }

    return { apiFormat: "responses", endpointUrl: `${baseUrl}/responses` };
  }

  if (apiFormat === "openai-chat") {
    return {
      apiFormat,
      endpointUrl: baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`,
    };
  }

  if (apiFormat === "anthropic-messages") {
    return {
      apiFormat,
      endpointUrl: baseUrl.endsWith("/messages") ? baseUrl : `${baseUrl}/messages`,
    };
  }

  return {
    apiFormat: "responses",
    endpointUrl: baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`,
  };
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const texts = [];

  for (const item of output) {
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const content of contents) {
      const value = content?.text ?? content?.output_text ?? "";
      if (typeof value === "string" && value) {
        texts.push(value);
      }
    }
  }

  return texts.join("\n").trim();
}

function extractChatCompletionText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const texts = [];

  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === "string" && content) {
      texts.push(content);
      continue;
    }

    const contentItems = Array.isArray(content) ? content : [];
    for (const item of contentItems) {
      const value = item?.text ?? item?.content ?? "";
      if (typeof value === "string" && value) {
        texts.push(value);
      }
    }
  }

  return texts.join("\n").trim();
}

function extractAnthropicMessageText(data) {
  const contentItems = Array.isArray(data?.content) ? data.content : [];
  const texts = [];

  for (const item of contentItems) {
    const value = item?.text ?? "";
    if (typeof value === "string" && value) {
      texts.push(value);
    }
  }

  return texts.join("\n").trim();
}
