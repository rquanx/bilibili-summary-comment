import { GoogleGenAI } from "@google/genai";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { buildSummaryPromptInput } from "./client";

const DEFAULT_GEMINI_PROXY_URL = "http://127.0.0.1:7897";
const GEMINI_RETRY_LIMIT = 3;
const GEMINI_RETRY_DELAYS_MS = [5_000, 10_000];

export async function requestSummaryWithGeminiSdk({
  pageNo,
  partTitle,
  durationSec,
  subtitleText,
  segments,
  promptProfile = null,
  model,
  apiKey,
  proxyUrl = process.env.GEMINI_PROXY_URL ?? DEFAULT_GEMINI_PROXY_URL,
}) {
  const normalizedApiKey = String(apiKey ?? "").trim();
  if (!normalizedApiKey) {
    throw new Error("Missing Gemini API key.");
  }

  const { systemPrompt, userPrompt } = buildSummaryPromptInput({
    pageNo,
    partTitle,
    durationSec,
    subtitleText,
    segments,
    promptProfile,
  });

  return withTemporaryGeminiEnvironment({
    apiKey: normalizedApiKey,
    proxyUrl,
  }, async () => {
    const ai = new GoogleGenAI({});
    let lastError = null;

    for (let attempt = 1; attempt <= GEMINI_RETRY_LIMIT; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
          },
        });

        const text = String(response.text ?? "").trim();
        if (!text) {
          throw new Error("Gemini summary response did not contain text output.");
        }

        return text;
      } catch (error) {
        lastError = error;
        if (!shouldRetryGeminiRequest(error) || attempt >= GEMINI_RETRY_LIMIT) {
          throw error;
        }

        await delay(GEMINI_RETRY_DELAYS_MS[attempt - 1] ?? GEMINI_RETRY_DELAYS_MS.at(-1) ?? 10_000);
      }
    }

    throw lastError ?? new Error("Gemini summary request failed.");
  });
}

async function withTemporaryGeminiEnvironment({ apiKey, proxyUrl }, callback) {
  const previousEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  const previousFetch = globalThis.fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  const proxiedFetch: typeof globalThis.fetch = ((input, init) => (
    undiciFetch(input, {
      ...(init ?? {}),
      dispatcher,
    }) as unknown as ReturnType<typeof globalThis.fetch>
  ));

  process.env.GEMINI_API_KEY = apiKey;
  delete process.env.GOOGLE_API_KEY;
  globalThis.fetch = proxiedFetch;

  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
    await dispatcher.close();
    restoreEnv("GEMINI_API_KEY", previousEnv.GEMINI_API_KEY);
    restoreEnv("GOOGLE_API_KEY", previousEnv.GOOGLE_API_KEY);
  }
}

function restoreEnv(key, value) {
  if (value == null) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function shouldRetryGeminiRequest(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /"code":503/u.test(message) || /"status":"UNAVAILABLE"/u.test(message);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
