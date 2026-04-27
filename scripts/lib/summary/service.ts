import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildSummarySegmentsFromSrt } from "../subtitle/srt-utils";
import { getVideoById, savePartSummary } from "../db/index";
import { writePartPromptArtifact, writePartSummaryArtifact } from "./files";
import { requestSummary } from "./client";
import { normalizeSummaryOutput } from "./output";
import { resolveSummaryPromptProfile } from "./prompt-config";

const KIMI_PRIMARY_MODEL = "kimi-k2.5";
const GLM_FALLBACK_MODEL = "glm-5";
const GEMINI_FLASH_FALLBACK_MODEL = "gemini-3-flash-preview";
const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_OPENAI_FORMAT = "openai-chat";
const KIMI_PROMPT_TOKENS_ERROR_PATTERN = /Cannot read properties of undefined \(reading 'prompt_tokens'\)/u;
const SUMMARY_CONTENT_FILTER_PATTERN = /content[_ -]?filter/iu;
const SUMMARY_HIGH_RISK_PATTERN = /high risk/iu;
const SUMMARY_TOO_MANY_REQUEST = /429 Too Many Requests/iu;

export function shouldRetrySummaryWithGlm5({ model, error }) {
  const normalizedModel = String(model ?? "").trim().toLowerCase();
  const message = error instanceof Error ? error.message : String(error ?? "");
  return normalizedModel === KIMI_PRIMARY_MODEL && (KIMI_PROMPT_TOKENS_ERROR_PATTERN.test(message) || SUMMARY_TOO_MANY_REQUEST.test(message));
}

export function shouldSkipSummaryPart({ error }) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SUMMARY_CONTENT_FILTER_PATTERN.test(message) && SUMMARY_HIGH_RISK_PATTERN.test(message);
}

export function shouldRetrySummaryWithGeminiFlash({ error, geminiApiKey }) {
  return Boolean(String(geminiApiKey ?? "").trim()) && shouldSkipSummaryPart({ error });
}

export async function requestSummaryWithFallback({
  requestArgs,
  requestSummaryImpl = requestSummary,
  onFallback = null,
  geminiApiKey = process.env.GEMINI_KEY ?? "",
}) {
  try {
    const summaryText = await requestSummaryImpl(requestArgs);
    return {
      summaryText,
      modelUsed: requestArgs.model,
      fallbackUsed: false,
      fallbackReason: null,
    };
  } catch (error) {
    const fallbackTarget = resolveSummaryFallbackTarget({
      model: requestArgs.model,
      error,
      geminiApiKey,
    });
    if (!fallbackTarget) {
      throw error;
    }

    await onFallback?.({
      failedModel: requestArgs.model,
      fallbackModel: fallbackTarget.model,
      fallbackReason: fallbackTarget.reason,
      error,
    });

    const summaryText = await requestSummaryImpl({
      ...requestArgs,
      ...fallbackTarget.requestOverrides,
    });

    return {
      summaryText,
      modelUsed: fallbackTarget.model,
      fallbackUsed: true,
      fallbackReason: fallbackTarget.reason,
    };
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
  promptConfigPath = null,
  ownerMid = null,
  ownerName = null,
  workRoot = "work",
  eventLogger = null,
  requestSummaryImpl = requestSummary,
  geminiApiKey = process.env.GEMINI_KEY ?? "",
}) {
  if (!apiKey) {
    throw new Error("Missing summary API key. Set SUMMARY_API_KEY or OPENAI_API_KEY.");
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
      model,
      apiFormat,
      subtitlePath,
    },
  });

  let promptPath = null;
  try {
    const subtitleText = fs.readFileSync(subtitlePath, "utf8");
    const segments = buildSummarySegmentsFromSrt(subtitleText, durationSec);
    const promptProfile = resolveSummaryPromptProfile({
      ownerMid,
      promptConfigPath,
    });
    const video = getVideoById(db, videoId) ?? {
      id: videoId,
      bvid,
      title: partTitle,
      owner_mid: ownerMid,
      owner_name: ownerName,
      owner_dir_name: null,
      work_dir_name: null,
    };
    promptPath = writePartPromptArtifact({
      db,
      video,
      pageNo,
      partTitle,
      durationSec,
      subtitleText,
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
      subtitleText,
      segments,
      promptProfile,
      model,
      apiKey,
      apiBaseUrl,
      apiFormat,
    };
    const summaryAttempt = await requestSummaryWithFallback({
      requestArgs: summaryRequest,
      requestSummaryImpl,
      geminiApiKey,
      onFallback: async ({ failedModel, fallbackModel, fallbackReason, error }) => {
        eventLogger?.log({
          scope: "summary",
          action: "llm-fallback",
          status: "started",
          pageNo,
          cid,
          partTitle,
          message: `Retrying summary with fallback model ${fallbackModel}`,
          details: {
            failedModel,
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
      subtitleText,
    });
    const normalized = `${normalizedSummary}\n`;
    const summaryHash = createHash("sha1").update(normalized).digest("hex");
    const saved = savePartSummary(db, videoId, pageNo, {
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
        requestedModel: model,
        fallbackUsed: summaryAttempt.fallbackUsed,
        fallbackReason: summaryAttempt.fallbackReason,
        segmentCount: segments.length,
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
          fallbackReason: summaryAttempt.fallbackReason,
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

function resolveSummaryFallbackTarget({ model, error, geminiApiKey }) {
  if (shouldRetrySummaryWithGlm5({ model, error })) {
    return {
      model: GLM_FALLBACK_MODEL,
      reason: "kimi-prompt_tokens-error",
      requestOverrides: {
        model: GLM_FALLBACK_MODEL,
      },
    };
  }

  if (shouldRetrySummaryWithGeminiFlash({ error, geminiApiKey })) {
    return {
      model: GEMINI_FLASH_FALLBACK_MODEL,
      reason: "content-filter-high-risk",
      requestOverrides: {
        model: GEMINI_FLASH_FALLBACK_MODEL,
        apiKey: String(geminiApiKey).trim(),
        apiBaseUrl: GEMINI_OPENAI_BASE_URL,
        apiFormat: GEMINI_OPENAI_FORMAT,
      },
    };
  }

  return null;
}
