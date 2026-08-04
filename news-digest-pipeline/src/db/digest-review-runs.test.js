import { createHash } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimDigestReviewPhase1Item,
  claimDigestReviewPhase2,
  claimReadyArticles,
  completeDigestReviewPhase2,
  completeDigestReviewPhase1Attempt,
  createDigest,
  createDigestReviewRun,
  freezeDigestReviewPhase2,
  finishDigestReviewPhase1,
  getDb,
  getDigest,
  getDigestReviewRun,
  getDigestReviewSourceArticles,
  initDb,
  insertArticle,
  isDigestReferencedByReviewRun,
  listDigestReviewRuns,
  recordDigestReviewItemResult,
  markDigestReviewPhase2CallStarted,
  markDigestReviewPhase1CallStarted,
  recoverDigestReviewPhase1,
  recoverDigestReviewPhase2,
  recordDigestReviewPhase2Response,
  rejectDigestReviewPhase2Attempt,
  resolveDigestReviewPhase1Ambiguity,
  setDigestReviewItemIncluded,
  updateDigest,
} from './index.js';

function addReadyArticle(number) {
  return insertArticle({
    url: `https://example.com/news-${number}`,
    title: `Original title ${number}`,
    content: `Original body ${number} ${'x'.repeat(120)}`,
  }).id;
}

function settings(overrides = {}) {
  return {
    sourceMaxChars: 6000,
    commentaryMinWords: 80,
    commentaryMaxWords: 150,
    phase1: { vendor: 'openai', model: 'phase-one', reasoningEffort: 'medium' },
    phase2: { vendor: 'openai', model: 'phase-two', reasoningEffort: 'medium' },
    ...overrides,
  };
}

function createQueueRun(count) {
  Array.from({ length: count }, (_, index) => addReadyArticle(index + 1));
  const claimed = claimReadyArticles({ limit: count, threshold: count, leaseMs: 60_000 });
  return createDigestReviewRun({
    sourceKind: 'queue',
    settings: settings(),
    articles: claimed,
    leaseId: claimed[0].processing_lease_id,
  });
}

function succeedAll(run, { inputTokens = 10, outputTokens = 5, costUsd = 0.01 } = {}) {
  for (const item of run.items) {
    recordDigestReviewItemResult({
      runId: run.id,
      itemId: item.id,
      status: 'succeeded',
      output: `Комментарий для новости ${item.position}`,
      wordCount: 82,
      inputTokens,
      outputTokens,
      costUsd,
    });
  }
  return finishDigestReviewPhase1(run.id);
}

function claimPhase2(runId) {
  freezeDigestReviewPhase2(runId);
  const run = claimDigestReviewPhase2(runId, {
    system: 'phase two',
    user: 'frozen items',
    maxTokens: 1000,
    vendor: 'openai',
    model: 'phase-two',
    reasoningEffort: 'medium',
  });
  const attempt = run.phase2_attempts.at(-1);
  markDigestReviewPhase2CallStarted(attempt.id);
  return { run: getDigestReviewRun(runId), attempt };
}

function recordPhase2(runId, content, { inputTokens = 0, outputTokens = 0, costUsd = null } = {}) {
  const { attempt } = claimPhase2(runId);
  recordDigestReviewPhase2Response(attempt.id, { content, inputTokens, outputTokens, costUsd });
  return attempt;
}

describe('digest review run persistence', () => {
  beforeEach(() => initDb(':memory:'));

  it('snapshots settings and sources while transferring the complete lease atomically', () => {
    addReadyArticle(1);
    addReadyArticle(2);
    const claimed = claimReadyArticles({ limit: 2, threshold: 2, leaseMs: 60_000 });
    const runSettings = settings({
      sourceMaxChars: 120,
      experiment: { name: 'long-input', enabled: true },
    });
    const run = createDigestReviewRun({
      sourceKind: 'queue',
      settings: runSettings,
      articles: claimed,
      leaseId: claimed[0].processing_lease_id,
    });

    expect(run).toMatchObject({
      source_kind: 'queue',
      status: 'phase1_processing',
      settings: runSettings,
      item_count: 2,
      selected_count: 0,
    });
    expect(run.settings_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.items.map((item) => item.position)).toEqual([1, 2]);
    expect(run.items.every((item) => /^[a-f0-9]{64}$/.test(item.source_sha256))).toBe(true);
    expect(run.items[0]).toMatchObject({
      source_title: 'Original title 1',
      source_url: 'https://example.com/news-1',
      included: 1,
      phase1_status: 'pending',
    });
    expect(run.items[0].content.length).toBeGreaterThan(120);

    const sourceId = run.items[0].article_id;
    getDb().prepare('UPDATE articles SET title = ?, content = ? WHERE id = ?')
      .run('Changed later', 'Changed later', sourceId);
    expect(getDigestReviewRun(run.id).items[0]).toMatchObject({
      title: 'Original title 1',
      content: expect.stringContaining('Original body 1'),
    });
    expect(getDb().prepare(
      'SELECT status, processing_lease_id FROM articles WHERE id = ?'
    ).get(sourceId)).toEqual({ status: 'digest_review', processing_lease_id: null });

    const summaries = listDigestReviewRuns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: run.id, item_count: 2, selected_count: 0 });
    expect(summaries[0]).not.toHaveProperty('settings_json');
    expect(summaries[0]).not.toHaveProperty('settings');
    expect(summaries[0]).not.toHaveProperty('items');
  });

  it('rejects a partial lease set without creating a run or changing any article', () => {
    addReadyArticle(1);
    addReadyArticle(2);
    const claimed = claimReadyArticles({ limit: 2, threshold: 2, leaseMs: 60_000 });

    expect(() => createDigestReviewRun({
      sourceKind: 'queue',
      settings: settings(),
      articles: [claimed[0]],
      leaseId: claimed[0].processing_lease_id,
    })).toThrow('complete claimed article set');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digest_review_runs').get().count).toBe(0);
    expect(getDb().prepare(
      'SELECT COUNT(*) AS count FROM articles WHERE status = ? AND processing_lease_id = ?'
    ).get('processing', claimed[0].processing_lease_id).count).toBe(2);
  });

  it('atomically snapshots explicitly selected new articles for a manual run without a lease', () => {
    const first = addReadyArticle(1);
    const second = addReadyArticle(2);
    addReadyArticle(3);

    const run = createDigestReviewRun({
      sourceKind: 'manual',
      settings: settings(),
      articles: [
        { id: second, title: 'caller copy is ignored', url: 'caller', content: 'caller' },
        { id: first, title: 'caller copy is ignored', url: 'caller', content: 'caller' },
      ],
    });

    expect(run).toMatchObject({ source_kind: 'manual', lease_id: null, item_count: 2 });
    expect(run.items.map((item) => item.article_id)).toEqual([second, first]);
    expect(run.items.map((item) => item.title)).toEqual(['Original title 2', 'Original title 1']);
    expect(getDb().prepare('SELECT status FROM articles WHERE id = ?').get(first).status)
      .toBe('digest_review');
    expect(getDb().prepare('SELECT status FROM articles WHERE id = ?').get(second).status)
      .toBe('digest_review');
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM articles WHERE status = 'new'"
    ).get().count).toBe(1);
  });

  it('recovers only never-started Phase 1 work and quarantines a started call', () => {
    const run = createQueueRun(2);
    const request = { system: 's', user: 'u', model: 'phase-one', vendor: 'openai' };
    const firstAttempt = claimDigestReviewPhase1Item(run.id, run.items[0].id, request);
    markDigestReviewPhase1CallStarted(firstAttempt.id);
    completeDigestReviewPhase1Attempt(firstAttempt.id, {
      output: 'Durable completed result', wordCount: 3,
    });

    const neverSent = claimDigestReviewPhase1Item(run.id, run.items[1].id, request);
    const safelyRecovered = recoverDigestReviewPhase1(run.id);
    expect(safelyRecovered.items.map((item) => item.phase1_status)).toEqual(['succeeded', 'pending']);
    expect(safelyRecovered.phase1_attempts.find((attempt) => attempt.id === neverSent.id).state)
      .toBe('cancelled');
    expect(() => claimDigestReviewPhase1Item(run.id, run.items[1].id, {
      ...request, user: 'changed request',
    })).toThrow('does not match the original request');

    const possiblySent = claimDigestReviewPhase1Item(run.id, run.items[1].id, request);
    markDigestReviewPhase1CallStarted(possiblySent.id);
    const attention = recoverDigestReviewPhase1(run.id);
    expect(attention).toMatchObject({
      status: 'phase1_attention_required',
      ambiguous_count: 1,
    });
    expect(attention.items[0]).toMatchObject({
      phase1_status: 'succeeded',
      phase1_output: 'Durable completed result',
    });

    const resolved = resolveDigestReviewPhase1Ambiguity(run.id, run.items[1].id, 'skip');
    expect(resolved).toMatchObject({ status: 'phase1_processing', ambiguous_count: 0 });
    expect(finishDigestReviewPhase1(run.id)).toMatchObject({
      status: 'awaiting_review', succeeded_count: 1, failed_count: 1,
    });
  });

  it('recovers Phase 2 according to whether the provider call started', () => {
    const run = createQueueRun(1);
    succeedAll(run);
    freezeDigestReviewPhase2(run.id);
    const request = {
      system: 'phase two', user: 'frozen', maxTokens: 1000,
      vendor: 'openai', model: 'phase-two', reasoningEffort: 'medium',
    };

    const neverSentRun = claimDigestReviewPhase2(run.id, request);
    const neverSent = neverSentRun.phase2_attempts.at(-1);
    expect(recoverDigestReviewPhase2(run.id)).toMatchObject({ status: 'phase2_retryable' });
    expect(getDigestReviewRun(run.id).phase2_attempts.find((attempt) => attempt.id === neverSent.id).state)
      .toBe('failed_retryable');
    expect(() => claimDigestReviewPhase2(run.id, {
      ...request, user: 'changed frozen request',
    })).toThrow('does not match the original request');

    const possiblySentRun = claimDigestReviewPhase2(run.id, request);
    const possiblySent = possiblySentRun.phase2_attempts.at(-1);
    markDigestReviewPhase2CallStarted(possiblySent.id);
    expect(recoverDigestReviewPhase2(run.id)).toMatchObject({ status: 'phase2_inconclusive' });
    expect(() => claimDigestReviewPhase2(run.id, request)).toThrow('not retryable');
  });

  it('freezes a reviewed 30-item run as 25 selected items and locks inclusion', () => {
    const run = createQueueRun(30);
    const reviewed = succeedAll(run);
    expect(reviewed).toMatchObject({
      status: 'awaiting_review',
      succeeded_count: 30,
      selected_count: 30,
    });

    for (const item of reviewed.items.slice(0, 5)) {
      setDigestReviewItemIncluded(run.id, item.id, false);
    }
    const { run: claimed } = claimPhase2(run.id);
    expect(claimed).toMatchObject({
      status: 'phase2_processing',
      item_count: 30,
      selected_count: 25,
    });
    expect(claimed.phase2_items).toHaveLength(25);
    expect(claimed.phase2_items.map((item) => item.position)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 6)
    );
    expect(() => setDigestReviewItemIncluded(run.id, reviewed.items[5].id, false))
      .toThrow('inclusion is locked');
  });

  it('marks failed Phase 1 sources as errors and keeps a rejected Phase 2 retryable', () => {
    const run = createQueueRun(2);
    recordDigestReviewItemResult({
      runId: run.id,
      itemId: run.items[0].id,
      status: 'succeeded',
      output: 'Успешный комментарий',
      wordCount: 80,
    });
    recordDigestReviewItemResult({
      runId: run.id,
      itemId: run.items[1].id,
      status: 'failed',
      error: 'provider failed',
    });

    const reviewed = finishDigestReviewPhase1(run.id);
    expect(reviewed).toMatchObject({
      status: 'awaiting_review',
      succeeded_count: 1,
      failed_count: 1,
      selected_count: 1,
    });
    expect(getDb().prepare('SELECT status FROM articles WHERE id = ?').get(run.items[0].article_id).status)
      .toBe('awaiting_review');
    expect(getDb().prepare('SELECT status FROM articles WHERE id = ?').get(run.items[1].article_id).status)
      .toBe('error');

    const { attempt } = claimPhase2(run.id);
    expect(rejectDigestReviewPhase2Attempt(attempt.id, 'assembly rejected', {
      retryable: true,
    })).toMatchObject({
      status: 'phase2_retryable',
      error: 'assembly rejected',
      result_digest_id: null,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(0);
  });

  it('creates one review-only digest, aggregates both phases, and finalizes source states', () => {
    const run = createQueueRun(3);
    const reviewed = succeedAll(run, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    setDigestReviewItemIncluded(run.id, reviewed.items[0].id, false);
    recordPhase2(run.id, '#новости\n\nНовый черновик', {
      inputTokens: 20,
      outputTokens: 8,
      costUsd: 0.04,
    });
    const firstDigestId = completeDigestReviewPhase2(run.id, { date: '2026-08-02' });
    const secondDigestId = completeDigestReviewPhase2(run.id, { date: '2026-08-03' });

    expect(secondDigestId).toBe(firstDigestId);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM digests').get().count).toBe(1);
    expect(getDigest(firstDigestId)).toMatchObject({
      status: 'ready_for_review',
      articles_count: 2,
      input_tokens: 50,
      output_tokens: 23,
      cost_usd: 0.07,
    });
    expect(getDigestReviewRun(run.id)).toMatchObject({
      status: 'ready_for_review',
      result_digest_id: firstDigestId,
      selected_count: 2,
    });

    const states = getDb().prepare(
      'SELECT id, status, digest_id FROM articles ORDER BY url ASC'
    ).all();
    expect(states[0]).toMatchObject({ status: 'excluded', digest_id: null });
    expect(states.slice(1).every((article) => (
      article.status === 'used' && article.digest_id === firstDigestId
    ))).toBe(true);
  });

  it('keeps full frozen source content available to a later larger-limit rerun', () => {
    const fullContent = `Full source ${'z'.repeat(500)}`;
    insertArticle({
      url: 'https://example.com/full-rerun-source',
      title: 'Full rerun source',
      content: fullContent,
    });
    const [claimed] = claimReadyArticles({ limit: 1, threshold: 1, leaseMs: 60_000 });
    const run = createDigestReviewRun({
      sourceKind: 'queue',
      settings: settings({ sourceMaxChars: 100 }),
      articles: [claimed],
      leaseId: claimed.processing_lease_id,
    });
    expect(run.items[0].content).toBe(fullContent);

    const reviewed = succeedAll(run);
    recordPhase2(run.id, 'Review draft from a short Phase 1 slice');
    const resultDigestId = completeDigestReviewPhase2(run.id, { date: '2026-08-02' });

    expect(reviewed.status).toBe('awaiting_review');
    expect(getDigestReviewSourceArticles(resultDigestId)).toMatchObject([
      { id: claimed.id, content: fullContent, position: 1 },
    ]);
  });

  it('reruns immutable source snapshots without mutating the original digest articles', () => {
    const articleId = addReadyArticle(1);
    const sourceDigestId = createDigest({ date: '2026-07-29', articlesCount: 1 });
    updateDigest(sourceDigestId, { content: 'Original bad digest', status: 'ready_for_review' });
    getDb().prepare("UPDATE articles SET status = 'used', digest_id = ? WHERE id = ?")
      .run(sourceDigestId, articleId);
    const sources = getDigestReviewSourceArticles(sourceDigestId);

    const rerun = createDigestReviewRun({
      sourceKind: 'rerun',
      sourceDigestId,
      sourceOrderKind: 'legacy_digest_order',
      settings: settings({ sourceMaxChars: 7000 }),
      articles: sources,
    });
    const reviewed = succeedAll(rerun);
    recordPhase2(rerun.id, 'Rerun review draft', {
      inputTokens: 2,
      outputTokens: 1,
      costUsd: 0.01,
    });
    const resultDigestId = completeDigestReviewPhase2(rerun.id, { date: '2026-08-02' });

    expect(getDb().prepare('SELECT status, digest_id FROM articles WHERE id = ?').get(articleId))
      .toEqual({ status: 'used', digest_id: sourceDigestId });
    expect(getDigest(sourceDigestId).content).toBe('Original bad digest');
    expect(getDigestReviewSourceArticles(resultDigestId)).toMatchObject([
      { id: articleId, title: 'Original title 1', position: 1 },
    ]);
    expect(isDigestReferencedByReviewRun(sourceDigestId)).toBe(true);
    expect(isDigestReferencedByReviewRun(resultDigestId)).toBe(true);
    expect(() => getDb().prepare('DELETE FROM digests WHERE id = ?').run(sourceDigestId)).toThrow();
    expect(createHash('sha256').update(rerun.settings_json).digest('hex'))
      .toBe(rerun.settings_sha256);
    expect(reviewed.status).toBe('awaiting_review');
  });
});
