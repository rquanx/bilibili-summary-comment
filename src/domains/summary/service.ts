import fs from "node:fs";
import { createHash } from "node:crypto";
import { parseSrt } from "../subtitle/srt-utils";
import { inspectSubtitleQuality } from "../subtitle/quality";
import { getVideoById, savePartSummary } from "../../infra/db/index";
import { writePartPromptArtifact, writePartSummaryArtifact } from "./files";
import { requestSummary } from "./client";
import { requestSummaryWithGeminiSdk } from "./gemini";
import { normalizeSummaryOutput } from "./output";
import { resolveSummaryPromptProfile } from "./prompt-config";

const KIMI_PRIMARY_MODEL = "kimi-k2.5";
const DEFAULT_FALLBACK_MODEL = "deepseek-v4-pro";
const GEMINI_FLASH_FALLBACK_MODEL = "gemini-3-flash-preview";
const SUMMARY_REQUEST_MAX_ATTEMPTS = 4;
const SUMMARY_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const KIMI_PROMPT_TOKENS_ERROR_PATTERN = /Cannot read properties of undefined \(reading 'prompt_tokens'\)/u;
const SUMMARY_EMPTY_TEXT_OUTPUT_PATTERN = /Summary response did not contain text output\./u;
const SUMMARY_CONTENT_FILTER_PATTERN = /content[_ -]?filter/iu;
const SUMMARY_HIGH_RISK_PATTERN = /high risk/iu;
const SUMMARY_TOO_MANY_REQUEST = /429 Too Many Requests/iu;
const SUMMARY_FETCH_FAILED_PATTERN = /fetch failed/iu;
const SUMMARY_TRANSIENT_NETWORK_ERROR_PATTERN = /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|socket closed|other side closed|network error|headers timeout|body timeout|\bterminated\b)/iu;
const SUMMARY_TRANSIENT_HTTP_STATUS_PATTERN = /(?:408 Request Timeout|425 Too Early|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)/iu;
const SUMMARY_UNSUPPORTED_MODEL_PATTERN = /(?:model(?:_not_found| not found| does not exist| is not available| unavailable)|unsupported model|unknown model)/iu;
const EMPTY_SUMMARY_MAX_DURATION_SEC = 20;
const CLI_PROXY_FALLBACK_REASON = "cli-proxy-request-failed";
const CLI_PROXY_MAX_ATTEMPTS = 4;

export function shouldRetrySummaryWithGlm5({ model, error }) {
  return shouldRetrySummaryWithFallbackModel({
    model,
    error,
    fallbackModel: DEFAULT_FALLBACK_MODEL,
    onlyKimi: true,
  });
}

function shouldRetrySummaryWithFallbackModel({
  model,
  error,
  fallbackModel,
  onlyKimi = false,
}) {
  const normalizedModel = String(model ?? "").trim().toLowerCase();
  const message = error instanceof Error ? error.message : String(error ?? "");
  const canUseFallback = String(fallbackModel ?? "").trim()
    && (!onlyKimi || normalizedModel === KIMI_PRIMARY_MODEL);
  return Boolean(canUseFallback)
    && (
      KIMI_PROMPT_TOKENS_ERROR_PATTERN.test(message)
      || SUMMARY_TOO_MANY_REQUEST.test(message)
      || SUMMARY_EMPTY_TEXT_OUTPUT_PATTERN.test(message)
      || shouldRetrySummaryRequest({ error })
      || SUMMARY_UNSUPPORTED_MODEL_PATTERN.test(message)
    );
}

export function shouldSkipSummaryPart({ error }) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SUMMARY_CONTENT_FILTER_PATTERN.test(message) && SUMMARY_HIGH_RISK_PATTERN.test(message);
}

export function shouldRetrySummaryWithGeminiFlash({ error, geminiApiKey }) {
  return Boolean(String(geminiApiKey ?? "").trim()) && shouldSkipSummaryPart({ error });
}

export function shouldRetrySummaryRequest({ error }) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SUMMARY_FETCH_FAILED_PATTERN.test(message)
    || SUMMARY_TRANSIENT_NETWORK_ERROR_PATTERN.test(message)
    || SUMMARY_TRANSIENT_HTTP_STATUS_PATTERN.test(message);
}

export async function requestSummaryWithFallback({
  requestArgs,
  preferredRequestArgs = null,
  requestSummaryImpl = requestSummary,
  requestGeminiSummaryImpl = requestSummaryWithGeminiSdk,
  onFallback = null,
  onRetry = null,
  geminiApiKey = process.env.GEMINI_KEY ?? "",
  fallbackModel = process.env.SUMMARY_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
  maxRequestAttempts = SUMMARY_REQUEST_MAX_ATTEMPTS,
  sleepImpl = delay,
}) {
  const fallbackHistory = [];

  if (preferredRequestArgs) {
    try {
      const summaryText = await requestSummaryWithRetries({
        requestArgs: preferredRequestArgs,
        requestImpl: requestSummaryImpl,
        sleepImpl,
        maxAttempts: CLI_PROXY_MAX_ATTEMPTS,
        onRetry,
        provider: "cli-proxy",
      });
      return {
        summaryText,
        modelUsed: preferredRequestArgs.model,
        providerUsed: "cli-proxy",
        fallbackUsed: false,
        fallbackReason: null,
        fallbackHistory,
      };
    } catch (error) {
      const fallbackEntry = {
        failedProvider: "cli-proxy",
        failedModel: preferredRequestArgs.model,
        fallbackProvider: "opencode",
        fallbackModel: requestArgs.model,
        fallbackReason: CLI_PROXY_FALLBACK_REASON,
      };
      fallbackHistory.push(fallbackEntry);
      await onFallback?.({
        ...fallbackEntry,
        error,
      });
    }
  }

  try {
    const summaryText = await requestSummaryWithRetries({
      requestArgs,
      requestImpl: requestSummaryImpl,
      sleepImpl,
      maxAttempts: maxRequestAttempts,
      onRetry,
      provider: "primary",
    });
    return {
      summaryText,
      modelUsed: requestArgs.model,
      providerUsed: "opencode",
      fallbackUsed: fallbackHistory.length > 0,
      fallbackReason: fallbackHistory.at(-1)?.fallbackReason ?? null,
      fallbackHistory,
    };
  } catch (error) {
    const fallbackTarget = resolveSummaryFallbackTarget({
      model: requestArgs.model,
      error,
      geminiApiKey,
      fallbackModel,
    });
    if (!fallbackTarget) {
      throw error;
    }

    await onFallback?.({
      failedProvider: "opencode",
      failedModel: requestArgs.model,
      fallbackProvider: fallbackTarget.provider ?? "opencode",
      fallbackModel: fallbackTarget.model,
      fallbackReason: fallbackTarget.reason,
      error,
    });
    fallbackHistory.push({
      failedProvider: "opencode",
      failedModel: requestArgs.model,
      fallbackProvider: fallbackTarget.provider ?? "opencode",
      fallbackModel: fallbackTarget.model,
      fallbackReason: fallbackTarget.reason,
    });

    const fallbackRequestArgs = {
      ...requestArgs,
      ...fallbackTarget.requestOverrides,
    };
    const requestImpl = fallbackTarget.provider === "gemini-sdk"
      ? requestGeminiSummaryImpl
      : requestSummaryImpl;
    const summaryText = await requestSummaryWithRetries({
      requestArgs: fallbackRequestArgs,
      requestImpl,
      sleepImpl,
      maxAttempts: maxRequestAttempts,
      onRetry,
      provider: fallbackTarget.provider ?? "fallback",
    });

    return {
      summaryText,
      modelUsed: fallbackTarget.model,
      providerUsed: fallbackTarget.provider ?? "opencode",
      fallbackUsed: true,
      fallbackReason: fallbackTarget.reason,
      fallbackHistory,
    };
  }
}

async function requestSummaryWithRetries({
  requestArgs,
  requestImpl,
  sleepImpl,
  maxAttempts,
  onRetry,
  provider,
}) {
  let attempt = 1;

  while (true) {
    try {
      return await requestImpl({
        ...requestArgs,
        forceFreshConnection: attempt > 1,
      });
    } catch (error) {
      if (!shouldRetrySummaryRequest({ error }) || attempt >= Math.max(1, maxAttempts)) {
        throw error;
      }

      const nextDelayMs = computeSummaryRetryDelayMs(attempt);
      await onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        model: requestArgs.model,
        provider,
        error,
        nextDelayMs,
      });
      await sleepImpl(nextDelayMs);
      attempt += 1;
    }
  }
}

export async function summarizePartFromSubtitle({
  db,
  videoId,
  bvid,
  pageNo,
  cid = null,
  partTitle,
  durationSec,
  subtitlePath,
  model,
  apiKey,
  apiBaseUrl,
  apiFormat,
  sessionId = null,
  cliProxy = null,
  promptConfigPath = null,
  ownerMid = null,
  ownerName = null,
  workRoot = "work",
  eventLogger = null,
  requestSummaryImpl = requestSummary,
  requestGeminiSummaryImpl = requestSummaryWithGeminiSdk,
  geminiApiKey = process.env.GEMINI_KEY ?? "",
  fallbackModel = process.env.SUMMARY_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
}) {
  const cliProxyEnabled = Boolean(cliProxy?.enabled && String(cliProxy?.apiKey ?? "").trim());
  if (!apiKey && !(cliProxyEnabled && cliProxy?.apiKey)) {
    throw new Error(
      "Missing summary API key. Set SUMMARY_CLI_PROXY_API_KEY, SUMMARY_API_KEY, or OPENAI_API_KEY.",
    );
  }

  let promptPath = null;
  try {
    const subtitleText = fs.readFileSync(subtitlePath, "utf8");
    const subtitleInspection = inspectSubtitleForSummary(subtitleText);
    if (shouldStoreEmptySummaryForPart({
      durationSec,
      cueCount: subtitleInspection.usableCueCount,
    })) {
      const emptySummaryText = buildEmptySummaryMarker(pageNo);
      const normalized = `${emptySummaryText}\n`;
      const summaryHash = createHash("sha1").update(normalized).digest("hex");
      const saved = await savePartSummary(db, videoId, pageNo, {
        summaryText: emptySummaryText,
        summaryHash,
      });
      const video = await getVideoById(db, videoId) ?? {
        id: videoId,
        bvid,
        title: partTitle,
        owner_mid: ownerMid,
        owner_name: ownerName,
        owner_dir_name: null,
        work_dir_name: null,
      };
      const partSummaryPath = writePartSummaryArtifact({
        db,
        video,
        pageNo,
        summaryText: "",
        workRoot,
      });

      eventLogger?.log({
        scope: "summary",
        action: "skip",
        status: "skipped",
        pageNo,
        cid,
        partTitle,
        message: `Skipped summary output for trivial short part P${pageNo}`,
        details: {
          reason: "short-part-without-usable-subtitles",
          durationSec,
          cueCount: subtitleInspection.originalCueCount,
          usableCueCount: subtitleInspection.usableCueCount,
          removedCueCount: subtitleInspection.removedCueCount,
          subtitlePath,
          summaryPath: partSummaryPath,
        },
      });

      return {
        pageNo,
        summaryText: "",
        summaryHash,
        promptPath: null,
        summaryPath: partSummaryPath,
        dbRow: saved,
        modelUsed: null,
        fallbackUsed: false,
      };
    }

    eventLogger?.log({
      scope: "summary",
      action: "llm",
      status: "started",
      pageNo,
      cid,
      partTitle,
      message: `Starting LLM summary for P${pageNo}`,
      details: {
        model: cliProxyEnabled ? cliProxy.model : model,
        provider: cliProxyEnabled ? "cli-proxy" : "opencode",
        apiFormat: cliProxyEnabled ? cliProxy.apiFormat : apiFormat,
        subtitlePath,
      },
    });

    const promptProfile = resolveSummaryPromptProfile({
      ownerMid,
      promptConfigPath,
    });
    const video = await getVideoById(db, videoId) ?? {
      id: videoId,
      bvid,
      title: partTitle,
      owner_mid: ownerMid,
      owner_name: ownerName,
      owner_dir_name: null,
      work_dir_name: null,
    };
    promptPath = await writePartPromptArtifact({
      db,
      video,
      pageNo,
      partTitle,
      durationSec,
      subtitleText: subtitleInspection.effectiveSubtitleText,
      promptText: null,
      subtitlePath,
      promptProfile,
      promptConfigPath,
      ownerMid,
      workRoot,
    });
    const summaryRequest = {
      pageNo,
      partTitle,
      durationSec,
      subtitleText: subtitleInspection.effectiveSubtitleText,
      segments: null,
      promptProfile,
      model,
      apiKey,
      apiBaseUrl,
      apiFormat,
      sessionId,
    };
    const summaryAttempt = await requestSummaryWithFallback({
      requestArgs: summaryRequest,
      preferredRequestArgs: cliProxyEnabled
        ? {
            ...summaryRequest,
            model: cliProxy.model,
            apiKey: cliProxy.apiKey,
            apiBaseUrl: cliProxy.apiBaseUrl,
            apiFormat: cliProxy.apiFormat,
            sessionId: null,
          }
        : null,
      requestSummaryImpl,
      requestGeminiSummaryImpl,
      geminiApiKey,
      fallbackModel,
      onFallback: async ({
        failedProvider,
        failedModel,
        fallbackProvider,
        fallbackModel,
        fallbackReason,
        error,
      }) => {
        eventLogger?.log({
          scope: "summary",
          action: "llm-fallback",
          status: "started",
          pageNo,
          cid,
          partTitle,
          message: `Summary fallback from ${failedProvider} to ${fallbackProvider}`,
          details: {
            failedProvider,
            failedModel,
            fallbackProvider,
            fallbackModel,
            fallbackReason,
            originalError: error instanceof Error ? error.message : String(error ?? ""),
            subtitlePath,
          },
        });
      },
    });
    const pageSummary = summaryAttempt.summaryText;

    const normalizedSummary = normalizeSummaryOutput(pageSummary, pageNo, {
      subtitleText: subtitleInspection.effectiveSubtitleText,
    });
    const normalized = `${normalizedSummary}\n`;
    const summaryHash = createHash("sha1").update(normalized).digest("hex");
    const saved = await savePartSummary(db, videoId, pageNo, {
      summaryText: normalized.trim(),
      summaryHash,
    });

    const partSummaryPath = writePartSummaryArtifact({
      db,
      video,
      pageNo,
      summaryText: normalized.trim(),
      workRoot,
    });

    eventLogger?.log({
      scope: "summary",
      action: "llm",
      status: "succeeded",
      pageNo,
      cid,
      partTitle,
      message: `LLM summary ready for P${pageNo}`,
      details: {
        model: summaryAttempt.modelUsed,
        provider: summaryAttempt.providerUsed,
        requestedModel: model,
        preferredModel: cliProxyEnabled ? cliProxy.model : null,
        fallbackUsed: summaryAttempt.fallbackUsed,
        fallbackReason: summaryAttempt.fallbackReason,
        fallbackHistory: summaryAttempt.fallbackHistory,
        cueCount: subtitleInspection.originalCueCount,
        usableCueCount: subtitleInspection.usableCueCount,
        removedCueCount: subtitleInspection.removedCueCount,
        summaryHash,
        promptPath,
        summaryPath: partSummaryPath,
        summaryPromptOwnerMid: promptProfile.ownerMid,
        summaryPromptOwnerName: ownerName,
        summaryPromptPreset: promptProfile.preset ?? null,
        summaryPromptExtraRuleCount: promptProfile.extraRules.length,
      },
    });

    if (summaryAttempt.fallbackUsed) {
      eventLogger?.log({
        scope: "summary",
        action: "llm-fallback",
        status: "succeeded",
        pageNo,
        cid,
        partTitle,
        message: `Fallback summary succeeded with ${summaryAttempt.modelUsed}`,
        details: {
          requestedModel: model,
          modelUsed: summaryAttempt.modelUsed,
          providerUsed: summaryAttempt.providerUsed,
          fallbackReason: summaryAttempt.fallbackReason,
          fallbackHistory: summaryAttempt.fallbackHistory,
          subtitlePath,
        },
      });
    }

    return {
      pageNo,
      summaryText: normalized.trim(),
      summaryHash,
      promptPath,
      summaryPath: partSummaryPath,
      dbRow: saved,
      modelUsed: summaryAttempt.modelUsed,
      providerUsed: summaryAttempt.providerUsed,
      fallbackUsed: summaryAttempt.fallbackUsed,
    };
  } catch (error) {
    eventLogger?.log({
      scope: "summary",
      action: "llm",
      status: "failed",
      pageNo,
      cid,
      partTitle,
      message: error?.message ?? "Unknown summary error",
      details: {
        model,
        subtitlePath,
        promptPath,
        fallbackEligible: Boolean(resolveSummaryFallbackTarget({
          model,
          error,
          geminiApiKey,
        })),
      },
    });
    throw error;
  }
}

function resolveSummaryFallbackTarget({ model, error, geminiApiKey, fallbackModel }) {
  const normalizedFallbackModel = String(fallbackModel ?? "").trim();
  if (shouldRetrySummaryWithFallbackModel({
    model,
    error,
    fallbackModel: normalizedFallbackModel,
  })) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const isKimiPrimary = String(model ?? "").trim().toLowerCase() === KIMI_PRIMARY_MODEL;
    return {
      model: normalizedFallbackModel,
      reason: isKimiPrimary && SUMMARY_TOO_MANY_REQUEST.test(message)
        ? "kimi-rate-limit"
        : shouldRetrySummaryRequest({ error })
          ? isKimiPrimary ? "kimi-network-error" : "primary-network-error"
        : SUMMARY_UNSUPPORTED_MODEL_PATTERN.test(message)
          ? "primary-model-unavailable"
        : SUMMARY_EMPTY_TEXT_OUTPUT_PATTERN.test(message)
          ? isKimiPrimary ? "kimi-empty-text-response" : "primary-empty-text-response"
          : isKimiPrimary ? "kimi-prompt_tokens-error" : "primary-provider-error",
      requestOverrides: {
        model: normalizedFallbackModel,
      },
    };
  }

  if (shouldRetrySummaryWithGeminiFlash({ error, geminiApiKey })) {
    return {
      model: GEMINI_FLASH_FALLBACK_MODEL,
      reason: "content-filter-high-risk",
      provider: "gemini-sdk",
      requestOverrides: {
        model: GEMINI_FLASH_FALLBACK_MODEL,
        apiKey: String(geminiApiKey).trim(),
        proxyUrl: process.env.GEMINI_PROXY_URL ?? "http://127.0.0.1:7897",
      },
    };
  }

  return null;
}

function computeSummaryRetryDelayMs(attempt: number) {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return SUMMARY_RETRY_DELAYS_MS[
    Math.min(normalizedAttempt - 1, SUMMARY_RETRY_DELAYS_MS.length - 1)
  ];
}

function shouldStoreEmptySummaryForPart({
  durationSec,
  cueCount,
}: {
  durationSec: number;
  cueCount: number;
}) {
  return Number(durationSec) > 0
    && Number(durationSec) <= EMPTY_SUMMARY_MAX_DURATION_SEC
    && Number(cueCount) === 0;
}

function inspectSubtitleForSummary(subtitleText: string) {
  const qualityCheck = inspectSubtitleQuality(subtitleText);
  const effectiveSubtitleText = qualityCheck.removedCueCount > 0
    ? qualityCheck.sanitizedSrt
    : subtitleText;

  return {
    originalCueCount: qualityCheck.totalCueCount,
    usableCueCount: parseSrt(effectiveSubtitleText).length,
    removedCueCount: qualityCheck.removedCueCount,
    effectiveSubtitleText,
  };
}

function buildEmptySummaryMarker(pageNo: number) {
  return `<${pageNo}P>`;
}

function delay(timeoutMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
