// ─────────────────────────────────────────────────────────────────────────────
// Shared vendor-agnostic LLM call.
//
// Extracted verbatim from digest-generator.js so more than one caller (the
// digest generator AND the pro moderation judge) can issue a single-shot model
// call without each re-implementing vendor routing, the OpenAI reasoning_effort
// / max_completion_tokens fallbacks, and 429 retry.
//
// The ONLY behavioural change vs the inlined version is that model + vendor are
// now parameters (defaulting to config.claudeModel / config.llmVendor). Passing
// neither reproduces the original behaviour byte-for-byte, which is exactly how
// digest-generator.js calls it — so existing digest behaviour is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { officialProviderBaseUrl } from './provider-endpoints.js';

const RETRY_ATTEMPTS = 3;
const MAX_VISION_DATA_URL_CHARS = 3 * 1024 * 1024;

// Only the Telegram adapter constructs this value today, but validate it again at
// the vendor boundary: generic callers must not turn the LLM helper into a remote
// URL fetcher or bypass the image-size limits by passing arbitrary content.
function normalizeVisionImage(image) {
  if (!image) return null;
  const dataUrl = image.dataUrl;
  if (typeof dataUrl !== 'string'
    || dataUrl.length > MAX_VISION_DATA_URL_CHARS
    || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    throw new Error('Некорректное изображение для OpenAI vision');
  }
  return { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } };
}

/**
 * Classify a failed model call: is retrying pointless until a human fixes the
 * config (permanent), or will it likely heal on its own (transient)?
 *
 * Both SDKs (Anthropic + OpenAI) attach `status` to API errors; local config
 * errors (missing key) and network errors carry no status. Measured incident:
 * a deploy without OPENAI_API_KEY made every call throw synchronously — that
 * MUST classify as permanent so the owner is alerted immediately, not after a
 * day of blind retries.
 *
 * @returns {{kind: string, permanent: boolean}} kind ∈ config | auth |
 *   model_not_found | bad_request | quota | rate_limit | server | network | unknown
 */
export function classifyLlmError(err) {
  const msg = String(err?.message || '');
  const status = err?.status;
  const code = String(err?.code || err?.error?.code || '');

  // Thrown by us before any HTTP request: the vendor's key is not configured.
  // (The Anthropic SDK's own no-credentials throw is caught here too, in case a
  // caller constructs the client without going through callModel's pre-check.)
  if (status == null && (/API key не настроен/i.test(msg) || /Could not resolve authentication method/i.test(msg))) {
    return { kind: 'config', permanent: true };
  }
  if (status === 401 || status === 403) return { kind: 'auth', permanent: true };
  if (status === 404) return { kind: 'model_not_found', permanent: true };
  if (status === 400) return { kind: 'bad_request', permanent: true };
  if (status === 429) {
    // OpenAI reports an exhausted balance as 429/insufficient_quota — that is
    // NOT a rate limit and never heals by waiting a few minutes.
    if (code.includes('insufficient_quota') || msg.includes('insufficient_quota') || /quota|billing/i.test(msg)) {
      return { kind: 'quota', permanent: true };
    }
    return { kind: 'rate_limit', permanent: false };
  }
  if (typeof status === 'number' && status >= 500) return { kind: 'server', permanent: false };
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EPIPE|fetch failed|network|socket hang up|Connection error/i.test(msg + ' ' + code)) {
    return { kind: 'network', permanent: false };
  }
  return { kind: 'unknown', permanent: false };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single model call (already vendor-specific) with exponential-backoff
 * retry on 429. `fn` returns the raw vendor response.
 */
export async function withRetry(fn, attempt = 1) {
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 429 && attempt < RETRY_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[llm] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${RETRY_ATTEMPTS})`);
      await sleep(delay);
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

/**
 * Vendor-agnostic single-shot model call. Routes to Anthropic (default) or
 * OpenAI. Returns text plus token usage.
 *
 * @param {Object} config App config (llmVendor, claudeModel, *BaseUrl, *ApiKey)
 * @param {{system:string, user:string, maxTokens:number, model?:string, vendor?:string,
 *          reasoningEffort?:string, image?:{dataUrl:string}}} opts
 *        model  — defaults to config.claudeModel
 *        vendor — defaults to config.llmVendor
 *        reasoningEffort — per-call override of config.openaiReasoningEffort.
 *          Needed because reasoning tokens are billed as OUTPUT: a call that must
 *          answer one word (a router/classifier) would otherwise inherit the global
 *          'medium' and burn hundreds of hidden tokens per call — measured here as
 *          an empty answer that spent its whole 500-token budget on reasoning.
 *          Pass 'none' to strip the parameter entirely for this call.
 * @returns {Promise<{text:string, inputTokens:number, outputTokens:number}>}
 */
export async function callModel(config, { system, user, maxTokens, model, vendor, reasoningEffort, image }) {
  const resolvedVendor = vendor || config.llmVendor || 'anthropic';
  const resolvedModel = model || config.claudeModel;

  if (resolvedVendor === 'openai') {
    if (!config.openaiApiKey) {
      throw new Error('OpenAI API key не настроен (.env: OPENAI_API_KEY)');
    }
    // Lazy import so the package is never loaded for the anthropic path and a
    // missing install does not break startup.
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: config.openaiApiKey,
      // Always pass an explicit official endpoint. Leaving this undefined lets
      // the SDK read OPENAI_BASE_URL from process.env independently of the
      // validated app config, which could bypass the endpoint policy.
      baseURL: config.openaiBaseUrl || officialProviderBaseUrl('openai'),
    });
    const visionImage = normalizeVisionImage(image);
    const request = {
      model: resolvedModel,
      messages: [
        { role: 'system', content: system },
        visionImage
          ? { role: 'user', content: [{ type: 'text', text: user }, visionImage] }
          : { role: 'user', content: user },
      ],
    };
    // Per-call override wins over the global setting; the explicit string 'none'
    // means "send no reasoning_effort at all", which is how a caller opts a cheap
    // classifier out of the account-wide default.
    const effort = reasoningEffort !== undefined ? reasoningEffort : config.openaiReasoningEffort;
    if (effort && effort !== 'none') {
      request.reasoning_effort = effort;
    }
    let resp;
    try {
      resp = await withRetry(() => client.chat.completions.create({
        ...request,
        max_completion_tokens: maxTokens,
      }));
    } catch (err) {
      const message = String(err.message || '');
      if (request.reasoning_effort && message.includes('reasoning_effort')) {
        delete request.reasoning_effort;
        resp = await withRetry(() => client.chat.completions.create({
          ...request,
          max_completion_tokens: maxTokens,
        }));
      } else if (!message.includes('max_completion_tokens')) {
        throw err;
      } else {
        resp = await withRetry(() => client.chat.completions.create({
          ...request,
          max_tokens: maxTokens,
        }));
      }
    }
    return {
      text: resp.choices[0]?.message?.content || '',
      inputTokens: resp.usage?.prompt_tokens || 0,
      outputTokens: resp.usage?.completion_tokens || 0,
    };
  }

  if (image) {
    throw new Error('Изображения поддерживаются только для OpenAI');
  }

  // Default: Anthropic. Same pre-check as the OpenAI path — a missing key must
  // classify as a permanent config error, not whatever the SDK happens to throw.
  if (!config.anthropicApiKey) {
    throw new Error('Anthropic API key не настроен (.env: ANTHROPIC_API_KEY)');
  }
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    // Same explicit-default rule as OpenAI: do not let the SDK consult an
    // unvalidated process environment value after config has been built.
    baseURL: config.anthropicBaseUrl || officialProviderBaseUrl('anthropic'),
  });
  const resp = await withRetry(() => client.messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }));
  return {
    text: resp.content[0]?.text || '',
    inputTokens: resp.usage?.input_tokens || 0,
    outputTokens: resp.usage?.output_tokens || 0,
  };
}
