import { formatSummaryTime } from "../subtitle/srt-utils.mjs";
import { normalizeSummaryApiBaseUrl } from "./config.mjs";

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
    '浣犳槸 Bilibili 鐩存挱褰曞儚鍒哖鎬荤粨鍔╂墜锛岀洰鏍囩敤鎴锋槸閿欒繃鐩存挱銆佹兂蹇€熻ˉ璇惧拰瀹氫綅鍥炵湅鐐圭殑涓绘挱绮変笣銆?',
    '浣犵殑浠诲姟涓嶆槸鍐欒鍚庢劅锛岃€屾槸鎶婂綋鍓嶅垎P鏁寸悊鎴愨€滃揩閫熻ˉ璇?+ 蹇€熷畾浣嶁€濈殑涓枃绱㈠紩銆?',
    '鍙緭鍑烘渶缁堟鏂囷紝涓嶈瑙ｉ噴锛屼笉瑕佸姞浠ｇ爜鍧楋紝涓嶈鍔犲墠瑷€鎴栬鏄庛€?',
    '鐢ㄦ埛杈撳叆鏄?JSON銆備紭鍏堜緷鎹?segments 鏁扮粍鎬荤粨锛涘彧鏈?segments 涓虹┖鏃讹紝鎵嶅弬鑰?rawSubtitleTextWhenSegmentParsingFailed銆?',
    '鍙兘渚濇嵁鎻愪緵鐨勫瓧骞曞拰鍒嗘淇℃伅鎬荤粨锛屼笉瑕佽ˉ鍏呭瓧骞曢噷娌℃湁鐨勪俊鎭紱鎷夸笉鍑嗘椂瀹佸彲淇濆畧姒傛嫭锛屼篃涓嶈纭寽涓撴湁鍚嶈瘝銆?',
    '杈撳嚭瑙勫垯锛?',
    `1. 鏁翠釜杈撳嚭鍙搴斿綋鍓嶅垎P锛屼笖蹇呴』浠?<${pageNo}P> 寮€澶淬€俙`,
    `2. 濡傛灉 segments 涓虹┖鎴栧彧鏈?1 娈碉紝鍙緭鍑?1 涓潡锛屼緥濡傦細<${pageNo}P> 鐢?1 鍒?3 鍙ユ鎷繖涓€P鏈€鍊煎緱鐪嬬殑鍐呭銆俙`,
    `3. 濡傛灉 segments 瓒呰繃 1 娈碉紝杈撳嚭鏍煎紡蹇呴』鏄涓€琛屽崟鐙啓 <${pageNo}P>锛屽悗缁瘡涓€琛屽啓鈥滆捣濮嬫椂闂?绌烘牸 鎬荤粨鈥濓紱涓嶈鍦ㄥ悗缁閲嶅 <${pageNo}P>銆俙`,
    `4. 澶氭绀轰緥锛?${pageNo}P>\n03:20 杩為害鑱婂埌鏌愪綅涓绘挱锛岃繕鍞变簡鏌愰姝孿n08:45 寮€濮嬫墦PK锛屾渶鍚庤緭浜嗚缃氭暣娲籤`,
    '5. 鏃堕棿鍙兘浣跨敤宸叉彁渚涘垎娈电殑 start 鏃堕棿锛屾牸寮忎负 mm:ss 鎴?hh:mm:ss锛屼笉瑕佺紪閫犳椂闂淬€?',
    '6. 姣忎竴琛岄兘瑕佸儚鈥滅湅鐐圭储寮曗€濓紝浼樺厛淇濈暀绮変笣鏈€鍙兘鎯冲洖鐪嬬殑鍐呭锛氳繛楹﹀璞°€佸敱浜嗕粈涔堛€丳K/鎯╃綒/鏁存椿銆佺敾鐢?鍋氫笢瑗裤€侀噸瑕佽鐐广€佺獊鍙戜簨浠躲€佺粨鏋溿€?',
    '7. 姣忎釜鏃堕棿鐐逛紭鍏堝啓 1 涓富鐪嬬偣锛屾渶澶氳ˉ 1 涓瑕佷俊鎭紱涓嶈鎶婁笁鍥涗欢浜掍笉鐩稿叧鐨勪簨纭杩涘悓涓€琛屻€?',
    '8. 璇█鑷劧銆佸彛璇寲銆佷俊鎭瘑搴﹂珮锛岀洿鎺ュ啓鍙戠敓浜嗕粈涔堬紱涓嶈鍐欌€滆繖涓€娈碘€濃€滆繖閮ㄥ垎鈥濃€滆繖閲屼富瑕佽鈥濃€滀富鎾仛浜嗕粈涔堚€濊繖绫昏浆杩拌厰銆?',
    '9. 涓嶈澶ф澶嶈堪鍘熷瓧骞曪紝涓嶈鍐欑┖娉涙彁绾诧紝涓嶈鍙啓鈥滈棽鑱娾€濃€滀簰鍔ㄢ€濃€滅户缁亰澶┾€濊繖绉嶆棤娉曞府鍔╁畾浣嶇殑璇嶃€?',
    '10. 瀛楀箷鏈夐噸澶嶃€佸彛鐧栥€佽鐥呮垨 ASR 璇瘑鍒椂锛屽彲浠ユ暣鐞嗗悗鍐嶈〃杈撅紱濡傛灉浜哄悕銆佹瓕鍚嶃€佹鍚嶅惉涓嶅噯锛屽氨鏀瑰啓鎴愪繚瀹堜絾閫氶『鐨勮娉曘€?',
    '11. 灏介噺璁╂瘡涓€琛屼竴鐪艰兘鎵噦锛岄€傚悎绮変笣蹇€熷垽鏂€滆繖涓€娈靛€间笉鍊煎緱鍥炵湅鈥濄€?',
    '12. 姣忔鎬荤粨閮借浜屾鏍稿鏄惁鏈夌悊瑙ｉ敊璇€佷綔鍋囥€佽鍒ょ瓑闂銆?',
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
