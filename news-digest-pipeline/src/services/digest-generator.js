import {
  claimDigestReviewPhase1Item,
  claimDigestReviewPhase2,
  completeDigestReviewPhase1Attempt,
  completeDigestReviewPhase2,
  createDigestReviewRun,
  failDigestReviewPhase1Attempt,
  finishDigestReviewPhase1,
  freezeDigestReviewPhase2,
  getDigestReviewRun,
  getDigestReviewSourceArticles,
  markDigestReviewPhase1AttemptAmbiguous,
  markDigestReviewPhase1CallStarted,
  markDigestReviewPhase2CallStarted,
  recoverDigestReviewPhase1,
  recoverDigestReviewPhase2,
  recordDigestReviewPhase2Response,
  rejectDigestReviewPhase2Attempt,
  resolveDigestReviewPhase1Ambiguity,
} from '../db/index.js';
import { MODEL_CATALOG, priceFor } from '../data/model-catalog.js';
import { callModel, classifyLlmError, sleep } from './llm.js';

const INTER_CALL_DELAY_MS = 200;
const DEFAULT_SOURCE_MAX_CHARS = 6000;
const DEFAULT_COMMENTARY_MIN_WORDS = 80;
const DEFAULT_COMMENTARY_MAX_WORDS = 150;
const REASONING_EFFORTS = ['', 'minimal', 'low', 'medium', 'high'];

export const CLASSIC_DIGEST_TARGET_SIZE = 30;

function effectivePhase1Prompt(config) {
  if (config.activeScenario === 'architect' && config.deepPrompt?.trim()) {
    return config.deepPrompt;
  }
  return config.commentaryPrompt;
}

function integerSetting(name, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function stringSetting(name, value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function validateModelRoute(config, phase, vendor, model, reasoningEffort) {
  if (!Object.hasOwn(MODEL_CATALOG, vendor)) {
    throw new Error(`${phase}Vendor is not supported`);
  }
  const isCatalogModel = MODEL_CATALOG[vendor].some((entry) => entry.id === model);
  const isCurrentConfiguredRoute = vendor === (config.llmVendor || 'anthropic')
    && model === config.claudeModel;
  if (!isCatalogModel && !isCurrentConfiguredRoute) {
    throw new Error(`${phase}Model is not available for ${vendor}`);
  }
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error(`${phase}ReasoningEffort must be empty, minimal, low, medium or high`);
  }
}

/**
 * Validate and materialize every setting that can affect a review run. The
 * returned object is persisted with the run, so Phase 2 and later reruns never
 * inherit silently changed process configuration.
 */
export function normalizeDigestReviewSettings(config, overrides = {}) {
  const sourceMaxChars = integerSetting(
    'sourceMaxChars',
    overrides.sourceMaxChars ?? DEFAULT_SOURCE_MAX_CHARS,
    100,
    50_000,
  );
  const commentaryMinWords = integerSetting(
    'commentaryMinWords',
    overrides.commentaryMinWords ?? DEFAULT_COMMENTARY_MIN_WORDS,
    10,
    2_000,
  );
  const commentaryMaxWords = integerSetting(
    'commentaryMaxWords',
    overrides.commentaryMaxWords ?? DEFAULT_COMMENTARY_MAX_WORDS,
    10,
    2_000,
  );
  if (commentaryMinWords > commentaryMaxWords) {
    throw new Error('commentaryMinWords must not exceed commentaryMaxWords');
  }

  const defaultVendor = config.llmVendor || 'anthropic';
  const defaultModel = config.claudeModel;
  const defaultReasoning = config.openaiReasoningEffort || '';
  const phase1Vendor = overrides.phase1Vendor ?? defaultVendor;
  const phase1Model = overrides.phase1Model ?? defaultModel;
  const phase1ReasoningEffort = overrides.phase1ReasoningEffort ?? defaultReasoning;
  const phase2Vendor = overrides.phase2Vendor ?? defaultVendor;
  const phase2Model = overrides.phase2Model ?? defaultModel;
  const phase2ReasoningEffort = overrides.phase2ReasoningEffort ?? defaultReasoning;

  validateModelRoute(config, 'phase1', phase1Vendor, phase1Model, phase1ReasoningEffort);
  validateModelRoute(config, 'phase2', phase2Vendor, phase2Model, phase2ReasoningEffort);

  return {
    sourceMaxChars,
    commentaryMinWords,
    commentaryMaxWords,
    phase1Vendor,
    phase1Model,
    phase1ReasoningEffort,
    phase2Vendor,
    phase2Model,
    phase2ReasoningEffort,
    phase1Prompt: stringSetting(
      'phase1Prompt',
      overrides.phase1Prompt ?? effectivePhase1Prompt(config),
    ),
    phase2Prompt: stringSetting(
      'phase2Prompt',
      overrides.phase2Prompt ?? config.assemblyPrompt,
    ),
    activeScenario: overrides.activeScenario ?? config.activeScenario ?? 'sarcastic',
    courseMention: stringSetting(
      'courseMention',
      overrides.courseMention ?? config.courseMention ?? '',
      { allowEmpty: true },
    ),
    boundaryIntent: stringSetting(
      'boundaryIntent',
      overrides.boundaryIntent ?? config.boundaryIntent ?? '',
      { allowEmpty: true },
    ),
    hashtagsSuffix: stringSetting(
      'hashtagsSuffix',
      overrides.hashtagsSuffix ?? config.hashtagsSuffix ?? '',
      { allowEmpty: true },
    ),
  };
}

export function getDigestReviewOptions(config) {
  const modelCatalog = Object.fromEntries(
    Object.entries(MODEL_CATALOG).map(([vendor, models]) => [
      vendor,
      models.map((model) => ({ ...model })),
    ]),
  );
  const currentVendor = config.llmVendor || 'anthropic';
  const currentModel = config.claudeModel;
  if (Object.hasOwn(modelCatalog, currentVendor)
    && currentModel
    && !modelCatalog[currentVendor].some((entry) => entry.id === currentModel)) {
    modelCatalog[currentVendor].push({
      id: currentModel,
      label: `${currentModel} (current configuration)`,
      pricing: null,
    });
  }
  return {
    defaults: normalizeDigestReviewSettings(config),
    modelCatalog,
    reasoningEfforts: [...REASONING_EFFORTS],
  };
}

function countWords(text) {
  const normalized = String(text || '').trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function costFor(model, inputTokens, outputTokens) {
  const pricing = priceFor(model);
  if (!pricing) return null;
  const raw = (inputTokens / 1e6) * pricing.input
    + (outputTokens / 1e6) * pricing.output;
  return Math.round(raw * 1e6) / 1e6;
}

function commentarySystemPrompt(settings) {
  return [
    settings.phase1Prompt,
    '',
    `ОБЯЗАТЕЛЬНО: комментарий должен содержать от ${settings.commentaryMinWords} до ${settings.commentaryMaxWords} слов включительно.`,
  ].join('\n');
}

function phase1MaxTokens(settings) {
  return Math.min(8192, Math.max(512, Math.ceil(settings.commentaryMaxWords * 2.5)));
}

function phase1Request(item, settings) {
  const content = String(item.content ?? item.source_content ?? '')
    .slice(0, settings.sourceMaxChars);
  const title = item.title ?? item.source_title ?? '';
  return {
    system: commentarySystemPrompt(settings),
    user: title ? `${title}\n\n${content}` : content,
    maxTokens: phase1MaxTokens(settings),
    vendor: settings.phase1Vendor,
    model: settings.phase1Model,
    reasoningEffort: settings.phase1ReasoningEffort,
  };
}

async function executePhase1(runId, config) {
  let processed = 0;
  while (true) {
    const run = getDigestReviewRun(runId);
    if (!run) throw new Error('Digest review run not found');
    if (['phase1_attention_required', 'awaiting_review', 'failed'].includes(run.status)) {
      return run;
    }
    if (run.status !== 'phase1_processing') {
      throw new Error('Digest review run is not in Phase 1');
    }
    const item = run.items.find((candidate) => candidate.phase1_status === 'pending');
    if (!item) {
      if (run.items.some((candidate) => (
        candidate.phase1_status === 'processing' || candidate.phase1_status === 'ambiguous'
      ))) return run;
      return finishDigestReviewPhase1(run.id);
    }

    const request = phase1Request(item, run.settings);
    const attempt = claimDigestReviewPhase1Item(run.id, item.id, request);
    markDigestReviewPhase1CallStarted(attempt.id);
    let response;
    try {
      response = await callModel(config, request);
      const output = String(response.text || '').trim();
      if (!output) {
        failDigestReviewPhase1Attempt(attempt.id, 'Phase 1 returned an empty response');
      } else {
        completeDigestReviewPhase1Attempt(attempt.id, {
          output,
          wordCount: countWords(output),
          inputTokens: response.inputTokens || 0,
          outputTokens: response.outputTokens || 0,
          costUsd: costFor(
            run.settings.phase1Model,
            response.inputTokens || 0,
            response.outputTokens || 0,
          ),
        });
      }
    } catch (error) {
      const message = String(error?.message || error);
      if (response) {
        try {
          markDigestReviewPhase1AttemptAmbiguous(
            attempt.id,
            `Provider response could not be persisted: ${message}`
          );
        } catch {
          // The attempt remains `calling`; explicit recovery will quarantine it
          // without issuing another request.
        }
        throw error;
      }
      const classification = classifyLlmError(error);
      if (classification.permanent || classification.kind === 'rate_limit') {
        failDigestReviewPhase1Attempt(attempt.id, message);
      } else {
        markDigestReviewPhase1AttemptAmbiguous(attempt.id, message);
        return getDigestReviewRun(run.id);
      }
    }

    processed += 1;
    if (processed < run.items.length) await sleep(INTER_CALL_DELAY_MS);
  }
}

/**
 * Create an immutable review run and execute Phase 1 only. The returned id is
 * an operator-review target, not a final digest id.
 */
export async function generateDigest(db, articles, config, options = {}) {
  void db;
  if (!Array.isArray(articles) || articles.length === 0) {
    throw new Error('At least one source article is required');
  }

  const {
    leaseId = null,
    settings = null,
    sourceDigestId = null,
    sourceOrderKind = 'claimed_order',
  } = options;
  const sourceKind = options.sourceKind ?? (leaseId ? 'queue' : 'manual');

  const snapshot = normalizeDigestReviewSettings(config, settings || {});
  const orderedArticles = articles.map((article, index) => ({
    ...article,
    position: article.position ?? index + 1,
  }));
  const run = createDigestReviewRun({
    sourceKind,
    sourceDigestId,
    sourceOrderKind,
    leaseId,
    settings: snapshot,
    articles: orderedArticles,
  });

  try {
    await executePhase1(run.id, config);
  } catch (error) {
    // The run and its attempt ledger already exist. Keep the recovery target
    // addressable to queue/HTTP callers instead of losing its id in a generic
    // 500; the persisted status tells the operator what can be resumed safely.
    if (!getDigestReviewRun(run.id)) throw error;
  }
  return run.id;
}

/** Explicit restart recovery; never retries an attempt that may have been sent. */
export async function recoverDigestReviewPhase1Run(db, runId, config) {
  void db;
  const recovered = recoverDigestReviewPhase1(runId);
  if (recovered.status === 'phase1_processing') return executePhase1(runId, config);
  return recovered;
}

export async function resolveDigestReviewPhase1RunItem(
  db,
  runId,
  itemId,
  config,
  { action, confirmPossibleDuplicateCost = false } = {},
) {
  void db;
  if (action === 'retry' && confirmPossibleDuplicateCost !== true) {
    throw new Error('Retrying an ambiguous Phase 1 item requires explicit cost confirmation');
  }
  const resolved = resolveDigestReviewPhase1Ambiguity(runId, itemId, action);
  if (resolved.status === 'phase1_processing') return executePhase1(runId, config);
  return resolved;
}

/** Create a new run from frozen sources of an existing digest. */
export async function createDigestRerun(db, sourceDigestId, config, settingsOverrides = {}) {
  const articles = getDigestReviewSourceArticles(sourceDigestId);
  if (articles.length === 0) {
    throw new Error('Source digest has no articles to rerun');
  }
  return generateDigest(db, articles, config, {
    settings: settingsOverrides,
    sourceKind: 'rerun',
    sourceDigestId,
    sourceOrderKind: 'digest_order',
  });
}

function buildAssemblyUserMessage(items, settings) {
  const commentaryList = items
    .map((item, index) => {
      const url = item.source_url ?? item.url ?? '';
      return `${index + 1}. ${item.phase1_output}\n${url}`;
    })
    .join('\n\n');

  return [
    `Вот ${items.length} обработанных комментариев для сборки в дайджест:`,
    '',
    commentaryList,
    '',
    '---',
    `Упоминание курса (вставить в середине списка): ${settings.courseMention}`,
    '',
    `Граница/дисклеймер (в конце): ${settings.boundaryIntent}`,
    '',
    `Хэштеги (в самом конце): ${settings.hashtagsSuffix}`,
  ].join('\n');
}

function normalizeDigestContent(text) {
  let content = String(text || '').trim();
  const digestStart = content.indexOf('#новости');
  if (digestStart > 0) content = content.substring(digestStart);
  return content.replace(/^(#новости)\s*\n+\s*(1\.\s+)/u, '$1 $2');
}

/** Assemble a frozen, operator-reviewed Phase 1 selection exactly once. */
export async function assembleDigestReviewRun(db, runId, config, { confirmRetry = false } = {}) {
  void db;
  let existing = getDigestReviewRun(runId);
  if (!existing) throw new Error('Digest review run not found');
  if (existing.result_digest_id) return existing.result_digest_id;
  if (existing.status === 'phase2_output_ready') return completeDigestReviewPhase2(runId);
  if (existing.status === 'phase2_processing') {
    throw new Error('Phase 2 has an active attempt; recover it before continuing');
  }
  if (existing.status === 'phase2_inconclusive') {
    throw new Error('Phase 2 outcome is inconclusive; reconciliation is required');
  }
  if (existing.status === 'awaiting_review') existing = freezeDigestReviewPhase2(runId);
  if (existing.status !== 'phase2_retryable') {
    throw new Error('Digest review run cannot start Phase 2');
  }
  if (existing.phase2_attempt_count > 0 && confirmRetry !== true) {
    throw new Error('A paid Phase 2 retry requires explicit confirmation');
  }

  const items = [...(existing.phase2_items || [])]
    .sort((a, b) => a.position - b.position);
  if (items.length === 0) throw new Error('No included successful Phase 1 items');
  const settings = existing.settings;
  const request = {
    system: settings.phase2Prompt,
    user: buildAssemblyUserMessage(items, settings),
    maxTokens: 16_384,
    vendor: settings.phase2Vendor,
    model: settings.phase2Model,
    reasoningEffort: settings.phase2ReasoningEffort,
  };
  const run = claimDigestReviewPhase2(runId, request);
  const attempt = run.phase2_attempts.at(-1);
  markDigestReviewPhase2CallStarted(attempt.id);
  let response;
  try {
    response = await callModel(config, request);
    const content = normalizeDigestContent(response.text);
    if (!content) {
      rejectDigestReviewPhase2Attempt(attempt.id, 'Phase 2 returned an empty response', {
        retryable: true,
      });
      throw new Error('Phase 2 returned an empty response');
    }
    recordDigestReviewPhase2Response(attempt.id, {
      content,
      inputTokens: response.inputTokens || 0,
      outputTokens: response.outputTokens || 0,
      costUsd: costFor(
        settings.phase2Model,
        response.inputTokens || 0,
        response.outputTokens || 0,
      ),
    });
  } catch (error) {
    const current = getDigestReviewRun(runId);
    if (current?.status === 'phase2_processing') {
      const classification = response ? { permanent: false, kind: 'receipt' } : classifyLlmError(error);
      rejectDigestReviewPhase2Attempt(attempt.id, String(error?.message || error), {
        retryable: !response
          && (classification.permanent || classification.kind === 'rate_limit'),
      });
    }
    throw error;
  }
  return completeDigestReviewPhase2(runId);
}

/** Recover/finalize Phase 2 locally; this function never invokes a provider. */
export function recoverDigestReviewPhase2Run(db, runId) {
  void db;
  const recovered = recoverDigestReviewPhase2(runId);
  if (recovered.result_digest_id) return recovered.result_digest_id;
  if (recovered.status === 'phase2_output_ready') return completeDigestReviewPhase2(runId);
  return null;
}
