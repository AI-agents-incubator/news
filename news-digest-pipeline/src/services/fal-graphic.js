// ─────────────────────────────────────────────────────────────────────────────
// Application-callable FAL graphic-model adapter.
//
// This module deliberately has no knowledge of editorial copy, visual briefs,
// Instagram, or files on disk. Callers supply model-authored prompts; the
// adapter submits them verbatim and returns provider provenance. It never adds
// text, composes a layout, or downloads/edits an image.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';
import { fal as defaultFalClient } from '@fal-ai/client';

export const FAL_GRAPHIC_PROVIDER = 'fal.ai';

// These are the two FAL routes currently supported by the lab adapter. Keeping
// the allowlist in code makes an accidental arbitrary endpoint/cost change
// impossible through a caller argument. Change the versioned contract first if
// a different graphic model is approved.
export const FAL_GRAPHIC_MODELS = Object.freeze({
  background: 'fal-ai/flux/dev',
  // Recraft V3 is an application-callable composition trial. Like the initial
  // Flux/Kontext r02 result, the r03 trial did not prove exact Cyrillic
  // typography. It remains lab-only: this is never a local text overlay.
  composition: 'fal-ai/recraft/v3/image-to-image',
});

export const DEFAULT_GRAPHIC_DIMENSIONS = Object.freeze({ width: 1080, height: 1350 });

const MAX_PROMPT_CHARS = 12_000;
const MAX_DIMENSION = 2_048;
const MAX_PIXELS = 4_194_304;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requirePrompt(value) {
  if (typeof value !== 'string') throw new Error('FAL graphic prompt must be a string');
  if (!value.trim()) throw new Error('FAL graphic prompt is required');
  if (value.length > MAX_PROMPT_CHARS) {
    throw new Error(`FAL graphic prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  // The exact model-authored string is intentionally returned to FAL: do not
  // trim, rewrite, or supplement semantic content in this adapter.
  return value;
}

function requireDimensions(width, height) {
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
      throw new Error(`FAL graphic ${name} must be an integer from 1 to ${MAX_DIMENSION}`);
    }
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`FAL graphic dimensions exceed ${MAX_PIXELS} pixels`);
  }
  return { width, height };
}

function requireBackgroundImageUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192 || CONTROL_CHARS.test(value)) {
    throw new Error('FAL composition requires a valid public HTTPS backgroundImageUrl');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FAL composition requires a valid public HTTPS backgroundImageUrl');
  }
  // The provider fetches this URL server-side. Do not allow URL credentials,
  // localhost, private IPv4, or IPv6 loopback/link-local targets to become an
  // indirect SSRF path. A previous FAL output is the expected caller input.
  const host = url.hostname.toLowerCase();
  const privateIpv4 = /^(?:0|10|127)(?:\.\d{1,3}){3}$/.test(host)
    || /^169\.254(?:\.\d{1,3}){2}$/.test(host)
    || /^192\.168(?:\.\d{1,3}){2}$/.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host);
  const privateIpv6 = host === '[::1]' || host === '[::]' || host.startsWith('[fe80:')
    || host.startsWith('[fc') || host.startsWith('[fd');
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || host === 'localhost'
    || host.endsWith('.localhost')
    || privateIpv4
    || privateIpv6
  ) {
    throw new Error('FAL composition requires a public HTTPS backgroundImageUrl');
  }
  return url.href;
}

function requireFalKey(config) {
  const key = typeof config?.falKey === 'string' ? config.falKey.trim() : '';
  if (!key) {
    // Do not include a key value or examine process.env here. The application
    // config is the only credentials boundary for this adapter.
    throw new Error('FAL graphic model is not configured (config.falKey)');
  }
  return key;
}

function unknownTokenUsage(status, raw) {
  return {
    status,
    raw,
    inputTokens: 'unknown',
    outputTokens: 'unknown',
    totalTokens: 'unknown',
  };
}

/**
 * Preserve a provider usage payload exactly when the SDK exposes one. FAL's
 * typed subscribe result does not promise usage/token values, so absence must
 * remain an explicit state rather than being recorded as zero.
 */
export function extractFalUsage(result) {
  const raw = result?.usage ?? result?.data?.usage;
  if (raw == null) return unknownTokenUsage('not_reported_by_provider', 'unknown');

  const readNumber = (...keys) => {
    for (const key of keys) {
      if (typeof raw?.[key] === 'number') return raw[key];
    }
    return 'unknown';
  };
  return {
    status: 'reported_by_provider',
    // Keep this payload verbatim for ledger/accounting consumers. Do not derive
    // a cost or token count from timing metadata.
    raw,
    inputTokens: readNumber('input_tokens', 'inputTokens'),
    outputTokens: readNumber('output_tokens', 'outputTokens'),
    totalTokens: readNumber('total_tokens', 'totalTokens'),
  };
}

function outputImage(result) {
  const image = result?.data?.images?.[0];
  if (!image || typeof image.url !== 'string' || !image.url) {
    throw new Error('FAL graphic model returned no output image URL');
  }
  return {
    url: image.url,
    // The FAL SDK exposes remote-file metadata only. This adapter never writes
    // a local file, so `file` stays null unless FAL reports a remote filename.
    file: image.file_name || image.filename || null,
    contentType: image.content_type || image.contentType || 'unknown',
    width: Number.isInteger(image.width) ? image.width : 'unknown',
    height: Number.isInteger(image.height) ? image.height : 'unknown',
  };
}

/**
 * Invoke one approved FAL graphic route.
 *
 * `background` calls FLUX Dev with an exact `image_size` object.
 * `composition` calls the current Recraft V3 image-to-image lab route using
 * the previous public background URL. The caller must quality-gate its model
 * output and validate/normalize the result deterministically before any future
 * use; the adapter does not claim the route renders exact Cyrillic typography.
 *
 * @param {{falKey: string}} config application config; never reads process.env
 * @param {{mode?: 'background'|'composition', prompt: string, width?: number,
 *   height?: number, backgroundImageUrl?: string}} input
 * @param {{falClient?: {config: Function, subscribe: Function}}} deps test seam
 * @returns {Promise<{provider:string, model:string, requestId:string,
 *   request: object, output: object, usage: object}>}
 */
export async function generateFalGraphic(config, input = {}, deps = {}) {
  const mode = input.mode || 'background';
  if (!(mode in FAL_GRAPHIC_MODELS)) {
    throw new Error(`Unsupported FAL graphic mode: ${String(mode)}`);
  }

  const prompt = requirePrompt(input.prompt);
  const dimensions = requireDimensions(
    input.width ?? DEFAULT_GRAPHIC_DIMENSIONS.width,
    input.height ?? DEFAULT_GRAPHIC_DIMENSIONS.height
  );
  const falKey = requireFalKey(config);
  const falClient = deps.falClient || defaultFalClient;
  if (typeof falClient?.config !== 'function' || typeof falClient?.subscribe !== 'function') {
    throw new Error('FAL graphic client is unavailable');
  }

  let providerInput;
  let backgroundImageUrl = null;
  let dimensionsApplied = false;
  if (mode === 'background') {
    dimensionsApplied = true;
    providerInput = {
      prompt,
      image_size: dimensions,
      num_images: 1,
      num_inference_steps: 28,
      guidance_scale: 3.5,
      output_format: 'png',
    };
  } else {
    backgroundImageUrl = requireBackgroundImageUrl(input.backgroundImageUrl);
    providerInput = {
      prompt,
      image_url: backgroundImageUrl,
    };
  }

  // The installed FAL singleton has no per-call credentials option. Configure
  // it directly from the already-built application config immediately before
  // the call; no raw environment lookup happens in this module.
  falClient.config({ credentials: falKey });
  const model = FAL_GRAPHIC_MODELS[mode];
  const result = await falClient.subscribe(model, { input: providerInput });

  if (typeof result?.requestId !== 'string' || !result.requestId) {
    throw new Error('FAL graphic model returned no request ID');
  }

  return {
    provider: FAL_GRAPHIC_PROVIDER,
    model,
    requestId: result.requestId,
    request: {
      mode,
      prompt,
      promptSha256: sha256(prompt),
      dimensions,
      dimensionsApplied,
      backgroundImageUrl,
      providerInput,
    },
    output: outputImage(result),
    usage: extractFalUsage(result),
  };
}
