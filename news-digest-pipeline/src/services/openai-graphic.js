// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Image API adapter for durable Instagram custom visuals.
//
// This adapter is intentionally used only when the optional FAL credential is
// absent. It accepts the model-authored visual prompt, produces one local-ready
// JPEG payload, and exposes the provider request id for the source-post receipt.
// It does not read process.env: the validated application config is the only
// credentials boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { officialProviderBaseUrl } from './provider-endpoints.js';
import { withRetry } from './llm.js';

export const OPENAI_GRAPHIC_PROVIDER = 'openai';
export const OPENAI_GRAPHIC_MODEL = 'gpt-image-2';
export const OPENAI_GRAPHIC_DIMENSIONS = Object.freeze({ width: 1024, height: 1280 });

const MAX_PROMPT_CHARS = 12_000;
const MAX_EDGE = 3840;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const BASE64_IMAGE = /^[A-Za-z0-9+/]+={0,2}$/;

function requireOpenAiKey(config) {
  const key = typeof config?.openaiApiKey === 'string' ? config.openaiApiKey.trim() : '';
  if (!key) throw new Error('OpenAI graphic model is not configured (config.openaiApiKey)');
  return key;
}

function requirePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT_CHARS) {
    throw new Error(`OpenAI graphic prompt must be a non-empty string of at most ${MAX_PROMPT_CHARS} characters`);
  }
  return value.trim();
}

function requireDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 16 || height < 16 || width > MAX_EDGE || height > MAX_EDGE
    || width % 16 !== 0 || height % 16 !== 0) {
    throw new Error('OpenAI graphic dimensions must be multiples of 16 up to 3840px');
  }
  const pixels = width * height;
  if (pixels < MIN_PIXELS || pixels > MAX_PIXELS || Math.max(width, height) / Math.min(width, height) > 3) {
    throw new Error('OpenAI graphic dimensions are outside the supported GPT Image 2 range');
  }
  return { width, height };
}

function requireBase64Image(value) {
  if (typeof value !== 'string' || !value || !BASE64_IMAGE.test(value) || value.length % 4 !== 0) {
    throw new Error('OpenAI graphic model returned no valid base64 image');
  }
  return value;
}

function usage(result) {
  const raw = result?.usage;
  if (!raw) {
    return {
      status: 'not_reported_by_provider', raw: 'unknown',
      inputTokens: 'unknown', outputTokens: 'unknown', totalTokens: 'unknown',
    };
  }
  return {
    status: 'reported_by_provider', raw,
    inputTokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : 'unknown',
    outputTokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : 'unknown',
    totalTokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : 'unknown',
  };
}

/**
 * Generate one custom graphic through the OpenAI Image API.
 *
 * `gpt-image-2` returns base64 data. Keeping that data in memory only lets the
 * caller normalize/persist it atomically without exposing a temporary public URL.
 *
 * @param {{openaiApiKey:string, openaiBaseUrl?:string}} config application config
 * @param {{prompt:string, width?:number, height?:number}} input
 * @param {{OpenAI?: Function, client?: {images?: {generate: Function}}}} deps test seam
 * @returns {Promise<{provider:string, model:string, requestId:string,
 *   request:object, output:{b64Json:string, contentType:string, width:number, height:number}, usage:object}>}
 */
export async function generateOpenAiGraphic(config, input = {}, deps = {}) {
  const prompt = requirePrompt(input.prompt);
  const dimensions = requireDimensions(
    input.width ?? OPENAI_GRAPHIC_DIMENSIONS.width,
    input.height ?? OPENAI_GRAPHIC_DIMENSIONS.height,
  );
  const apiKey = requireOpenAiKey(config);
  const OpenAI = deps.OpenAI || (await import('openai')).default;
  const client = deps.client || new OpenAI({
    apiKey,
    baseURL: config.openaiBaseUrl || officialProviderBaseUrl('openai'),
  });
  if (typeof client?.images?.generate !== 'function') throw new Error('OpenAI graphic client is unavailable');

  const result = await withRetry(() => client.images.generate({
    model: OPENAI_GRAPHIC_MODEL,
    prompt,
    n: 1,
    size: `${dimensions.width}x${dimensions.height}`,
    quality: 'medium',
    output_format: 'jpeg',
    output_compression: 95,
    background: 'opaque',
  }));
  const requestId = typeof result?._request_id === 'string' ? result._request_id : '';
  if (!requestId) throw new Error('OpenAI graphic model returned no request ID');
  const b64Json = requireBase64Image(result?.data?.[0]?.b64_json);

  return {
    provider: OPENAI_GRAPHIC_PROVIDER,
    model: OPENAI_GRAPHIC_MODEL,
    requestId,
    request: {
      mode: 'background',
      dimensions,
      quality: 'medium',
      outputFormat: 'jpeg',
      outputCompression: 95,
    },
    output: {
      b64Json,
      contentType: 'image/jpeg',
      width: dimensions.width,
      height: dimensions.height,
    },
    usage: usage(result),
  };
}
