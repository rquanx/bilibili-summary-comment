import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildSummarySegmentsFromSrt, formatSummaryTime } from './srt-utils.mjs'
import { getRepoRoot } from './runtime-tools.mjs'
import { savePartSummary } from './storage.mjs'
import { parseSummaryBlocks } from './summary-format.mjs'

export async function summarizePartFromSubtitle({ db, videoId, bvid, pageNo, partTitle, durationSec, subtitlePath, model, apiKey, apiBaseUrl, apiFormat, workRoot = 'work' }) {
  if (!apiKey) {
    throw new Error('Missing summary API key. Set SUMMARY_API_KEY or OPENAI_API_KEY.')
  }

  const subtitleText = fs.readFileSync(subtitlePath, 'utf8')
  const segments = buildSummarySegmentsFromSrt(subtitleText, durationSec)
  const pageSummary = await requestSummary({
    pageNo,
    partTitle,
    durationSec,
    subtitleText,
    segments,
    model,
    apiKey,
    apiBaseUrl,
    apiFormat,
  })

  const normalizedSummary = normalizeSummaryOutput(pageSummary, pageNo)
  const normalized = `${normalizedSummary}\n`
  const summaryHash = createHash('sha1').update(normalized).digest('hex')
  const saved = savePartSummary(db, videoId, pageNo, {
    summaryText: normalized.trim(),
    summaryHash,
  })

  const workDir = path.join(getRepoRoot(), workRoot, bvid)
  fs.mkdirSync(workDir, { recursive: true })
  const partSummaryPath = path.join(workDir, `summary-p${String(pageNo).padStart(2, '0')}.md`)
  fs.writeFileSync(partSummaryPath, normalized, 'utf8')

  return {
    pageNo,
    summaryText: normalized.trim(),
    summaryHash,
    summaryPath: partSummaryPath,
    dbRow: saved,
  }
}

export function resolveSummaryConfig(args = {}) {
  return {
    model: args.model ?? process.env.SUMMARY_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    apiKey: args['api-key'] ?? process.env.SUMMARY_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
    apiBaseUrl: normalizeApiBaseUrl(args['api-base-url'] ?? process.env.SUMMARY_API_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'),
    apiFormat: normalizeApiFormat(args['api-format'] ?? process.env.SUMMARY_API_FORMAT ?? process.env.OPENAI_API_FORMAT ?? 'auto'),
  }
}

async function requestSummary({ pageNo, partTitle, durationSec, subtitleText, segments, model, apiKey, apiBaseUrl, apiFormat }) {
  const systemPrompt = [
    '你是 Bilibili 视频分P字幕总结助手，负责把单个分P的字幕整理成可直接发布到评论区的中文总结。',
    '只输出最终正文，不要解释，不要加代码块，不要加前言或说明。',
    '用户输入是 JSON。优先依据 segments 数组总结；只有 segments 为空时，才参考 rawSubtitleTextWhenSegmentParsingFailed。',
    '只能依据提供的字幕和分段信息总结，不要补充字幕里没有的信息；拿不准时宁可保守概括。',
    '输出规则：',
    `1. 整个输出只对应当前分P，且必须以 <${pageNo}P> 开头。`,
    `2. 如果 segments 为空或只有 1 段，只输出 1 个块，例如：<${pageNo}P> 用 1 到 3 句概括核心内容。`,
    `3. 如果 segments 超过 1 段，输出格式必须是第一行单独写 <${pageNo}P>，后续每一行写“起始时间 空格 总结”；不要在后续行重复 <${pageNo}P>。`,
    `4. 多段示例：<${pageNo}P>\n03:20 聊了……\n08:45 又提到……`,
    '5. 时间只能使用已提供分段的 start 时间，格式为 mm:ss 或 hh:mm:ss，不要编造时间。',
    '6. 语言自然、口语化、信息密度高，直接写聊了什么、做了什么、结论是什么。',
    '7. 不要使用“这一段”“这部分”“这里主要讲”“主播做了什么”这类转述腔。',
    '8. 不要大段复述原字幕，不要写成空泛提纲；优先提炼事件、观点、转折和结果。',
    '9. 字幕有重复、口癖或语病时，可以整理后再表达，但不要改变原意。',
  ].join('\\n')

  const segmentPayload =
    segments.length > 0
      ? segments.map((segment) => ({
          start: formatSummaryTime(segment.startSec),
          end: formatSummaryTime(segment.endSec),
          text: segment.text,
        }))
      : []

  const userPrompt = JSON.stringify({
    page: pageNo,
    partTitle,
    durationSec,
    subtitleFormat: 'srt',
    segments: segmentPayload.length > 0 ? segmentPayload : null,
    rawSubtitleTextWhenSegmentParsingFailed: segmentPayload.length === 0 ? subtitleText : null,
  })

  const api = resolveApiTarget(apiBaseUrl, apiFormat)
  const response = await fetch(
    api.endpointUrl,
    buildSummaryRequest({
      apiFormat: api.apiFormat,
      model,
      apiKey,
      systemPrompt,
      userPrompt,
    }),
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Summary request failed: ${response.status} ${response.statusText}\n${errorText}`)
  }

  const data = await response.json()
  const text = extractSummaryText(data, api.apiFormat)
  if (!text.trim()) {
    throw new Error('Summary response did not contain text output.')
  }

  return text.trim()
}

function normalizeSummaryOutput(text, pageNo) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return ''
  }

  const blocks = parseSummaryBlocks(normalized)
  if (blocks.length <= 1 || blocks.some((block) => block.page !== pageNo)) {
    return normalized
  }

  const markerPattern = new RegExp(`^<${pageNo}P>\\s*`, 'u')
  const bodyLines = []

  for (const block of blocks) {
    const lines = block.lines
      .map((line, index) => (index === 0 ? line.replace(markerPattern, '') : line))
      .filter((line, index, source) => !(index === 0 && line.trim() === '' && source.length === 1))

    bodyLines.push(...lines)
  }

  const compactBody = trimTrailingEmptyLines(bodyLines)
  if (compactBody.length === 0) {
    return `<${pageNo}P>`
  }

  return [`<${pageNo}P>`, ...compactBody].join('\n').trim()
}

function buildSummaryRequest({ apiFormat, model, apiKey, systemPrompt, userPrompt }) {
  if (apiFormat === 'openai-chat') {
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    }
  }

  if (apiFormat === 'anthropic-messages') {
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      }),
    }
  }

  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: userPrompt }],
        },
      ],
    }),
  }
}

function extractSummaryText(data, apiFormat) {
  if (apiFormat === 'openai-chat') {
    return extractChatCompletionText(data)
  }

  if (apiFormat === 'anthropic-messages') {
    return extractAnthropicMessageText(data)
  }

  return extractResponseText(data)
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string') {
    return data.output_text
  }

  const output = Array.isArray(data?.output) ? data.output : []
  const texts = []

  for (const item of output) {
    const contents = Array.isArray(item?.content) ? item.content : []
    for (const content of contents) {
      const value = content?.text ?? content?.output_text ?? ''
      if (typeof value === 'string' && value) {
        texts.push(value)
      }
    }
  }

  return texts.join('\n').trim()
}

function extractChatCompletionText(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : []
  const texts = []

  for (const choice of choices) {
    const content = choice?.message?.content
    if (typeof content === 'string' && content) {
      texts.push(content)
      continue
    }

    const contentItems = Array.isArray(content) ? content : []
    for (const item of contentItems) {
      const value = item?.text ?? item?.content ?? ''
      if (typeof value === 'string' && value) {
        texts.push(value)
      }
    }
  }

  return texts.join('\n').trim()
}

function extractAnthropicMessageText(data) {
  const contentItems = Array.isArray(data?.content) ? data.content : []
  const texts = []

  for (const item of contentItems) {
    const value = item?.text ?? ''
    if (typeof value === 'string' && value) {
      texts.push(value)
    }
  }

  return texts.join('\n').trim()
}

function resolveApiTarget(apiBaseUrl, apiFormat) {
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl)

  if (apiFormat === 'auto') {
    if (baseUrl.endsWith('/chat/completions')) {
      return { apiFormat: 'openai-chat', endpointUrl: baseUrl }
    }

    if (baseUrl.endsWith('/messages')) {
      return { apiFormat: 'anthropic-messages', endpointUrl: baseUrl }
    }

    if (baseUrl.endsWith('/responses')) {
      return { apiFormat: 'responses', endpointUrl: baseUrl }
    }

    return { apiFormat: 'responses', endpointUrl: `${baseUrl}/responses` }
  }

  if (apiFormat === 'openai-chat') {
    return {
      apiFormat,
      endpointUrl: baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`,
    }
  }

  if (apiFormat === 'anthropic-messages') {
    return {
      apiFormat,
      endpointUrl: baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/messages`,
    }
  }

  return {
    apiFormat: 'responses',
    endpointUrl: baseUrl.endsWith('/responses') ? baseUrl : `${baseUrl}/responses`,
  }
}

function normalizeApiBaseUrl(value) {
  return String(value ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
}

function normalizeApiFormat(value) {
  const normalized = String(value ?? 'auto')
    .trim()
    .toLowerCase()
  if (normalized === 'responses' || normalized === 'openai-chat' || normalized === 'anthropic-messages') {
    return normalized
  }
  return 'auto'
}

function trimTrailingEmptyLines(lines) {
  const result = [...lines]
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop()
  }
  return result
}
