import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llm.js', () => ({
  callModel: vi.fn(),
  classifyLlmError: vi.fn().mockReturnValue({ kind: 'config', permanent: true }),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import {
  assignArticlesToDigest,
  claimDigestReviewPhase1Item,
  claimDigestReviewPhase2,
  claimReadyArticles,
  createDigest,
  createDigestReviewRun,
  freezeDigestReviewPhase2,
  getDb,
  getDigest,
  getDigestReviewRun,
  initDb,
  insertArticle,
  markDigestReviewPhase2CallStarted,
  markDigestReviewPhase1CallStarted,
  recordDigestReviewPhase2Response,
  setDigestReviewItemIncluded,
  updateDigest,
} from '../db/index.js';
import {
  assembleDigestReviewRun,
  createDigestRerun,
  generateDigest,
  getDigestReviewOptions,
  normalizeDigestReviewSettings,
  recoverDigestReviewPhase1Run,
  recoverDigestReviewPhase2Run,
  resolveDigestReviewPhase1RunItem,
} from './digest-generator.js';
import { callModel, classifyLlmError } from './llm.js';

const config = {
  activeScenario: 'sarcastic',
  commentaryPrompt: 'commentary prompt',
  deepPrompt: 'architect prompt',
  assemblyPrompt: 'assembly prompt',
  courseMention: 'COURSE',
  boundaryIntent: 'FOOTER',
  hashtagsSuffix: '#one #two',
  processingLeaseMs: 60_000,
  llmVendor: 'openai',
  claudeModel: 'gpt-5.6-terra',
  openaiReasoningEffort: 'medium',
};

function addArticle(slug, content = `Source ${slug} `.repeat(12)) {
  return insertArticle({
    url: `https://example.com/${slug}`,
    title: `Title ${slug}`,
    content,
  }).id;
}

function claimArticles(count) {
  return claimReadyArticles({
    limit: count,
    threshold: count,
    leaseMs: config.processingLeaseMs,
  });
}

describe('digest review settings', () => {
  it('defaults to 6000 source chars, an 80-150 word range and independent routes', () => {
    expect(getDigestReviewOptions(config)).toMatchObject({
      defaults: {
        sourceMaxChars: 6000,
        commentaryMinWords: 80,
        commentaryMaxWords: 150,
        phase1Vendor: 'openai',
        phase1Model: 'gpt-5.6-terra',
        phase1ReasoningEffort: 'medium',
        phase2Vendor: 'openai',
        phase2Model: 'gpt-5.6-terra',
        phase2ReasoningEffort: 'medium',
        phase1Prompt: 'commentary prompt',
        phase2Prompt: 'assembly prompt',
      },
      reasoningEfforts: ['', 'minimal', 'low', 'medium', 'high'],
    });
  });

  it('rejects invalid numeric ranges and mismatched vendor/model pairs', () => {
    expect(() => normalizeDigestReviewSettings(config, {
      commentaryMinWords: 151,
      commentaryMaxWords: 150,
    })).toThrow('commentaryMinWords must not exceed commentaryMaxWords');
    expect(() => normalizeDigestReviewSettings(config, {
      phase1Vendor: 'anthropic',
      phase1Model: 'gpt-5.6-terra',
    })).toThrow('phase1Model is not available for anthropic');
  });

  it('accepts and snapshots the minimal reasoning effort supported by llm.js', () => {
    expect(normalizeDigestReviewSettings(config, {
      phase1ReasoningEffort: 'minimal',
      phase2ReasoningEffort: 'minimal',
    })).toMatchObject({
      phase1ReasoningEffort: 'minimal',
      phase2ReasoningEffort: 'minimal',
    });
  });

  it('keeps the exact current configured legacy model selectable', () => {
    const legacyConfig = {
      ...config,
      llmVendor: 'anthropic',
      claudeModel: 'claude-sonnet-4-20250514',
      openaiReasoningEffort: '',
    };

    expect(normalizeDigestReviewSettings(legacyConfig)).toMatchObject({
      phase1Vendor: 'anthropic',
      phase1Model: 'claude-sonnet-4-20250514',
      phase2Vendor: 'anthropic',
      phase2Model: 'claude-sonnet-4-20250514',
    });
    expect(getDigestReviewOptions(legacyConfig).modelCatalog.anthropic).toContainEqual({
      id: 'claude-sonnet-4-20250514',
      label: 'claude-sonnet-4-20250514 (current configuration)',
      pricing: null,
    });
    expect(() => normalizeDigestReviewSettings(legacyConfig, {
      phase1Model: 'arbitrary-legacy-model',
    })).toThrow('phase1Model is not available for anthropic');
  });
});

describe('two-stage digest review generation', () => {
  beforeEach(() => {
    initDb(':memory:');
    vi.clearAllMocks();
  });

  it('runs Phase 1 only, truncates at 6000 chars and snapshots its route', async () => {
    const articleId = addArticle('phase-one', 'x'.repeat(6500));
    const articles = claimArticles(1);
    const output = Array.from({ length: 79 }, (_, index) => `слово${index + 1}`).join(' ');
    callModel.mockResolvedValueOnce({ text: output, inputTokens: 100, outputTokens: 50 });

    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
      settings: {
        phase1Vendor: 'openai',
        phase1Model: 'gpt-5.6-luna',
        phase1ReasoningEffort: 'low',
        phase2Vendor: 'anthropic',
        phase2Model: 'claude-sonnet-4-6',
        phase2ReasoningEffort: 'high',
      },
    });

    const run = getDigestReviewRun(runId);
    expect(run).toMatchObject({
      id: runId,
      status: 'awaiting_review',
      succeeded_count: 1,
      failed_count: 0,
      result_digest_id: null,
      settings: {
        sourceMaxChars: 6000,
        commentaryMinWords: 80,
        commentaryMaxWords: 150,
        phase1Model: 'gpt-5.6-luna',
        phase2Model: 'claude-sonnet-4-6',
      },
    });
    expect(run.items[0]).toMatchObject({
      article_id: articleId,
      phase1_status: 'succeeded',
      phase1_output: output,
      phase1_word_count: 79,
    });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][1]).toMatchObject({
      vendor: 'openai',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      maxTokens: 512,
      user: `Title phase-one\n\n${'x'.repeat(6000)}`,
    });
    expect(callModel.mock.calls[0][1].system).toContain(
      'от 80 до 150 слов включительно',
    );
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(0);
    expect(getDb().prepare(
      'SELECT commentary, status, digest_id FROM articles WHERE id = ?'
    ).get(articleId)).toMatchObject({
      commentary: null,
      status: 'awaiting_review',
      digest_id: null,
    });
  });

  it('infers the safe manual source path when selected articles have no lease', async () => {
    const articleId = addArticle('manual-selection');
    const articles = getDb().prepare('SELECT * FROM articles WHERE id = ?').all(articleId);
    callModel.mockResolvedValueOnce({
      text: 'Manual Phase 1 output',
      inputTokens: 10,
      outputTokens: 5,
    });

    const runId = await generateDigest(getDb(), articles, config);

    expect(getDigestReviewRun(runId)).toMatchObject({
      source_kind: 'manual',
      status: 'awaiting_review',
      item_count: 1,
    });
    expect(getDb().prepare('SELECT status, commentary FROM articles WHERE id = ?').get(articleId))
      .toMatchObject({ status: 'awaiting_review', commentary: null });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('returns the addressable failed run when every Phase 1 item failed', async () => {
    const articleId = addArticle('all-failed');
    const articles = claimArticles(1);
    callModel.mockRejectedValueOnce(new Error('provider unavailable'));

    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
    });

    expect(runId).toEqual(expect.any(String));
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'failed',
      succeeded_count: 0,
      failed_count: 1,
      error: 'Phase 1 produced no successful items',
    });
    expect(getDb().prepare('SELECT status FROM articles WHERE id = ?').get(articleId).status)
      .toBe('error');
  });

  it('does not re-spend an interrupted Phase 1 call and resumes only untouched items', async () => {
    addArticle('phase1-ambiguous');
    addArticle('phase1-pending');
    const articles = claimArticles(2);
    const run = createDigestReviewRun({
      sourceKind: 'queue',
      settings: normalizeDigestReviewSettings(config),
      articles,
      leaseId: articles[0].processing_lease_id,
    });
    const interrupted = claimDigestReviewPhase1Item(run.id, run.items[0].id, {
      system: 'commentary prompt', user: 'sent request', maxTokens: 512,
      vendor: 'openai', model: 'gpt-5.6-terra', reasoningEffort: 'medium',
    });
    markDigestReviewPhase1CallStarted(interrupted.id);

    callModel.mockResolvedValue({ text: 'Only untouched item result', inputTokens: 9, outputTokens: 4 });
    const attention = await recoverDigestReviewPhase1Run(getDb(), run.id, config);
    expect(attention).toMatchObject({ status: 'phase1_attention_required', ambiguous_count: 1 });
    expect(callModel).not.toHaveBeenCalled();
    await expect(resolveDigestReviewPhase1RunItem(
      getDb(), run.id, run.items[0].id, config,
      { action: 'retry', confirmPossibleDuplicateCost: false }
    )).rejects.toThrow('explicit cost confirmation');

    const finished = await resolveDigestReviewPhase1RunItem(
      getDb(), run.id, run.items[0].id, config, { action: 'skip' }
    );
    expect(finished).toMatchObject({
      status: 'awaiting_review', succeeded_count: 1, failed_count: 1,
    });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(getDigestReviewRun(run.id).items.map((item) => item.phase1_status))
      .toEqual(['failed', 'succeeded']);
  });

  it('keeps the run addressable when a provider response cannot be persisted', async () => {
    addArticle('phase1-receipt-crash');
    const articles = claimArticles(1);
    getDb().exec(`
      CREATE TRIGGER fail_phase1_success_receipt
      BEFORE UPDATE OF phase1_status ON digest_review_items
      WHEN NEW.phase1_status = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt crash');
      END;
    `);
    callModel.mockResolvedValueOnce({ text: 'Paid provider response', inputTokens: 9, outputTokens: 4 });

    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
    });
    expect(runId).toEqual(expect.any(String));
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'phase1_attention_required',
      ambiguous_count: 1,
      items: [expect.objectContaining({ phase1_status: 'ambiguous' })],
    });
    expect(callModel).toHaveBeenCalledTimes(1);

    callModel.mockClear();
    expect(await recoverDigestReviewPhase1Run(getDb(), runId, config))
      .toMatchObject({ status: 'phase1_attention_required' });
    expect(callModel).not.toHaveBeenCalled();
  });

  it('assembles 25 of 30 enabled items in stable order and is idempotent', async () => {
    for (let index = 1; index <= 30; index++) {
      addArticle(`item-${String(index).padStart(2, '0')}`);
    }
    const articles = claimArticles(30);
    let phase1Ordinal = 0;
    callModel.mockImplementation(async () => {
      phase1Ordinal += 1;
      return {
        text: `commentary-${String(phase1Ordinal).padStart(2, '0')}`,
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
      settings: {
        phase1Model: 'gpt-5.6-luna',
        phase1ReasoningEffort: 'low',
        phase2Model: 'gpt-5.6-sol',
        phase2ReasoningEffort: 'high',
      },
    });
    const reviewed = getDigestReviewRun(runId);
    const disabledPositions = new Set([2, 7, 15, 22, 30]);
    for (const item of reviewed.items) {
      if (disabledPositions.has(item.position)) {
        setDigestReviewItemIncluded(runId, item.id, false);
      }
    }

    callModel.mockReset();
    callModel.mockResolvedValueOnce({
      text: 'Preamble\n#новости\n\n1. assembled digest',
      inputTokens: 200,
      outputTokens: 100,
    });
    const digestId = await assembleDigestReviewRun(getDb(), runId, config);
    const assemblyCall = callModel.mock.calls[0][1];
    const commentaryLines = assemblyCall.user
      .split('\n')
      .filter((line) => /^\d+\. commentary-/u.test(line));
    const expectedOutputs = Array.from({ length: 30 }, (_, index) => index + 1)
      .filter((position) => !disabledPositions.has(position))
      .map((position, index) => `${index + 1}. commentary-${String(position).padStart(2, '0')}`);

    expect(commentaryLines).toEqual(expectedOutputs);
    expect(assemblyCall).toMatchObject({
      system: 'assembly prompt',
      vendor: 'openai',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      maxTokens: 16_384,
    });
    expect(getDigest(digestId)).toMatchObject({
      id: digestId,
      articles_count: 25,
      status: 'ready_for_review',
      content: '#новости 1. assembled digest',
      model: 'gpt-5.6-sol',
    });
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'ready_for_review',
      selected_count: 25,
      result_digest_id: digestId,
    });

    await expect(assembleDigestReviewRun(getDb(), runId, config)).resolves.toBe(digestId);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('quarantines a timeout after Phase 2 dispatch and never retries it automatically', async () => {
    addArticle('phase2-timeout');
    const articles = claimArticles(1);
    callModel.mockResolvedValueOnce({ text: 'Phase 1 result', inputTokens: 10, outputTokens: 5 });
    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
    });

    callModel.mockReset();
    callModel.mockRejectedValueOnce(new Error('ETIMEDOUT after dispatch'));
    classifyLlmError.mockReturnValueOnce({ kind: 'network', permanent: false });
    await expect(assembleDigestReviewRun(getDb(), runId, config))
      .rejects.toThrow('ETIMEDOUT');
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'phase2_inconclusive',
      result_digest_id: null,
      phase2_attempt_count: 1,
    });
    await expect(assembleDigestReviewRun(getDb(), runId, config))
      .rejects.toThrow('reconciliation is required');
    expect(recoverDigestReviewPhase2Run(getDb(), runId)).toBeNull();
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(0);
  });

  it('retries a definitely rejected Phase 2 request only after explicit paid confirmation', async () => {
    addArticle('phase2-rejected');
    const articles = claimArticles(1);
    callModel.mockResolvedValueOnce({ text: 'Phase 1 result', inputTokens: 10, outputTokens: 5 });
    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
    });

    callModel.mockReset();
    callModel.mockRejectedValueOnce(new Error('API key not accepted'));
    classifyLlmError.mockReturnValueOnce({ kind: 'auth', permanent: true });
    await expect(assembleDigestReviewRun(getDb(), runId, config)).rejects.toThrow('API key');
    expect(getDigestReviewRun(runId)).toMatchObject({ status: 'phase2_retryable' });

    callModel.mockResolvedValueOnce({
      text: '#новости 1. Explicit retry result', inputTokens: 20, outputTokens: 8,
    });
    await expect(assembleDigestReviewRun(getDb(), runId, config))
      .rejects.toThrow('explicit confirmation');
    expect(callModel).toHaveBeenCalledTimes(1);
    const digestId = await assembleDigestReviewRun(getDb(), runId, config, { confirmRetry: true });
    expect(digestId).toEqual(expect.any(String));
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'ready_for_review', phase2_attempt_count: 2, result_digest_id: digestId,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(1);
  });

  it('finalizes a durable Phase 2 response after restart without another provider call', async () => {
    addArticle('phase2-recorded');
    const articles = claimArticles(1);
    callModel.mockResolvedValueOnce({ text: 'Phase 1 result', inputTokens: 10, outputTokens: 5 });
    const runId = await generateDigest(getDb(), articles, config, {
      leaseId: articles[0].processing_lease_id,
    });
    freezeDigestReviewPhase2(runId);
    const claimed = claimDigestReviewPhase2(runId, {
      system: 'assembly prompt', user: 'frozen request', maxTokens: 16_384,
      vendor: 'openai', model: 'gpt-5.6-terra', reasoningEffort: 'medium',
    });
    const attempt = claimed.phase2_attempts.at(-1);
    markDigestReviewPhase2CallStarted(attempt.id);
    recordDigestReviewPhase2Response(attempt.id, {
      content: '#новости 1. Durable response', inputTokens: 20, outputTokens: 8,
    });

    callModel.mockClear();
    getDb().exec(`
      CREATE TRIGGER fail_digest_finalize
      BEFORE INSERT ON digests
      BEGIN
        SELECT RAISE(ABORT, 'injected finalize crash');
      END;
    `);
    expect(() => recoverDigestReviewPhase2Run(getDb(), runId))
      .toThrow('injected finalize crash');
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'phase2_output_ready', result_digest_id: null,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(0);
    expect(callModel).not.toHaveBeenCalled();
    getDb().exec('DROP TRIGGER fail_digest_finalize');

    const digestId = recoverDigestReviewPhase2Run(getDb(), runId);
    expect(digestId).toEqual(expect.any(String));
    expect(recoverDigestReviewPhase2Run(getDb(), runId)).toBe(digestId);
    expect(callModel).not.toHaveBeenCalled();
    expect(getDigestReviewRun(runId)).toMatchObject({
      status: 'ready_for_review', result_digest_id: digestId,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(1);
  });

  it('reruns source snapshots and ignores legacy article commentary', async () => {
    const articleId = addArticle('legacy', 'Original source body');
    getDb().prepare('UPDATE articles SET commentary = ? WHERE id = ?')
      .run('LEGACY COMMENTARY MUST NOT BE USED', articleId);
    const sourceDigestId = createDigest({ date: '2026-08-01', articlesCount: 1 });
    updateDigest(sourceDigestId, {
      content: '#новости 1. Original digest',
      status: 'ready_for_review',
    });
    assignArticlesToDigest([articleId], sourceDigestId);
    callModel.mockResolvedValueOnce({
      text: 'Fresh Phase 1 output',
      inputTokens: 10,
      outputTokens: 5,
    });

    const runId = await createDigestRerun(getDb(), sourceDigestId, config, {
      sourceMaxChars: 6000,
    });
    const run = getDigestReviewRun(runId);

    expect(run).toMatchObject({
      source_kind: 'rerun',
      source_digest_id: sourceDigestId,
      status: 'awaiting_review',
      result_digest_id: null,
    });
    expect(callModel.mock.calls[0][1].user).toBe('Title legacy\n\nOriginal source body');
    expect(callModel.mock.calls[0][1].user).not.toContain('LEGACY COMMENTARY');
    expect(getDb().prepare('SELECT commentary, digest_id FROM articles WHERE id = ?').get(articleId))
      .toMatchObject({ commentary: 'LEGACY COMMENTARY MUST NOT BE USED', digest_id: sourceDigestId });
    expect(getDigest(sourceDigestId).content).toBe('#новости 1. Original digest');
  });
});
