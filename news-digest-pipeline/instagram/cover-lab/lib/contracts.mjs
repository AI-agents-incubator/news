import { createHash } from 'node:crypto';

export const USAGE_NOT_REPORTED = 'not_reported_by_provider';
export const USAGE_UNKNOWN = 'unknown';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

export function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/(api[_ -]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function nonEmptyOneLine(value, label, min, max) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)
    || value.trim().length < min || value.trim().length > max) {
    throw new Error(`${label} must be a non-empty one-line string of ${min}-${max} characters`);
  }
  return value.trim();
}

const LOG_LINE_META_LANGUAGE = /(?:^|\s)(?:пост|автор|сообщает|призывает|я|мы|он|она|они)(?=$|\s|[,.!?:;])/iu;

function assertImpersonalLogline(value, label) {
  if (LOG_LINE_META_LANGUAGE.test(value)) {
    throw new Error(`${label} contains prohibited author/post meta-language or narrator pronoun`);
  }
}

export function parseEditorialV2(text) {
  const value = JSON.parse(text);
  const keys = [
    'key_idea', 'hook', 'logline_candidates', 'selected_logline_index',
    'selected_logline', 'factual_anchor', 'facts_used',
  ];
  if (!exactKeys(value, keys)) throw new Error('editorial-card response does not match v2 JSON contract');
  nonEmptyOneLine(value.key_idea, 'key_idea', 1, 500);
  nonEmptyOneLine(value.hook, 'hook', 10, 90);
  nonEmptyOneLine(value.factual_anchor, 'factual_anchor', 1, 500);
  if (!Array.isArray(value.logline_candidates) || value.logline_candidates.length !== 3) {
    throw new Error('logline_candidates must contain exactly three values');
  }
  value.logline_candidates.forEach((candidate, index) => {
    nonEmptyOneLine(candidate, `logline_candidates[${index}]`, 20, 180);
    assertImpersonalLogline(candidate, `logline_candidates[${index}]`);
  });
  if (!Number.isInteger(value.selected_logline_index)
    || value.selected_logline_index < 0 || value.selected_logline_index > 2) {
    throw new Error('selected_logline_index must select one of the three candidates');
  }
  nonEmptyOneLine(value.selected_logline, 'selected_logline', 20, 180);
  assertImpersonalLogline(value.selected_logline, 'selected_logline');
  if (value.selected_logline !== value.logline_candidates[value.selected_logline_index]) {
    throw new Error('selected_logline must exactly equal the model-selected candidate');
  }
  if (!Array.isArray(value.facts_used) || value.facts_used.length < 1 || value.facts_used.length > 4
    || !value.facts_used.every((fact) => typeof fact === 'string' && fact.trim())) {
    throw new Error('facts_used must contain one to four non-empty strings');
  }
  return value;
}

export function parseVisualV1(text) {
  const value = JSON.parse(text);
  const keys = ['scene', 'subject', 'action', 'setting', 'composition', 'palette_and_light', 'absurd_twist', 'negative_constraints'];
  if (!exactKeys(value, keys) || !exactKeys(value.composition, ['camera', 'subject_position', 'text_safe_zone'])
    || !Array.isArray(value.negative_constraints) || value.negative_constraints.length < 3) {
    throw new Error('visual-director response does not match v1 JSON contract');
  }
  for (const key of ['scene', 'subject', 'action', 'setting', 'palette_and_light', 'absurd_twist']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`visual-director field ${key} is invalid`);
  }
  for (const key of Object.keys(value.composition)) {
    if (typeof value.composition[key] !== 'string' || !value.composition[key].trim()) {
      throw new Error(`visual-director composition.${key} is invalid`);
    }
  }
  if (!value.negative_constraints.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('visual-director negative_constraints entries are invalid');
  }
  return value;
}

export function modelUsage(result) {
  const input = Number.isFinite(result?.inputTokens) ? result.inputTokens : USAGE_NOT_REPORTED;
  const output = Number.isFinite(result?.outputTokens) ? result.outputTokens : USAGE_NOT_REPORTED;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number.isFinite(input) && Number.isFinite(output) ? input + output : USAGE_NOT_REPORTED,
  };
}

export function usageRecord({ runId, sampleId, step, attempt, provider, model, reasoningEffort, promptSha256, usage, status, at, requestId = null }) {
  if (!['succeeded', 'rejected', 'failed'].includes(status)) throw new Error(`invalid usage status: ${status}`);
  return {
    schema_version: 'instagram-cover-lab.usage.v1',
    run_id: runId,
    sample_id: sampleId,
    step,
    attempt,
    provider,
    model,
    reasoning_effort: reasoningEffort ?? 'not_applicable',
    rendered_prompt_sha256: promptSha256,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    provider_request_id: requestId,
    status,
    at,
  };
}
