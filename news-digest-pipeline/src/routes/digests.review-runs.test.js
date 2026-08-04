import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import config from '../config.js';
import {
  claimDigestReviewPhase1Item,
  claimDigestReviewPhase2,
  createDigest,
  createDigestReviewRun,
  getDb,
  getDigestReviewRun,
  initDb,
  insertArticle,
  freezeDigestReviewPhase2,
  markDigestReviewPhase1CallStarted,
  markDigestReviewPhase2CallStarted,
  recordDigestReviewPhase2Response,
} from '../db/index.js';
import { getDigestReviewOptions } from '../services/digest-generator.js';
import digestsRouter from './digests.js';

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/digests', digestsRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => initDb(':memory:'));

async function request(path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function createAwaitingReviewRun(suffix = 'default') {
  const inserted = insertArticle({
    url: `https://example.com/review-source-${suffix}`,
    title: 'Original title',
    content: 'Source body '.repeat(30),
  });
  const article = getDb().prepare('SELECT * FROM articles WHERE id = ?').get(inserted.id);
  const run = createDigestReviewRun({
    sourceKind: 'manual',
    sourceOrderKind: 'requested_order',
    settings: getDigestReviewOptions(config).defaults,
    articles: [article],
  });
  const item = run.items[0];
  getDb().prepare(
    `UPDATE digest_review_items
        SET phase1_status = 'succeeded', phase1_output = ?, phase1_word_count = 90
      WHERE id = ?`
  ).run('Finished first-pass commentary', item.id);
  getDb().prepare(
    `UPDATE digest_review_runs
        SET status = 'awaiting_review', phase1_completed_at = datetime('now')
      WHERE id = ?`
  ).run(run.id);
  getDb().prepare("UPDATE articles SET status = 'awaiting_review' WHERE id = ?")
    .run(item.article_id);
  return { runId: run.id, itemId: item.id };
}

describe('digest review-run routes', () => {
  it('keeps prompt-bearing options, run lists, and run details operator-only', async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousKey = process.env.API_SECRET_KEY;
    try {
      process.env.NODE_ENV = 'production';
      process.env.API_SECRET_KEY = 'review-route-key';

      expect((await request('/api/digests/review-runs/options')).status).toBe(401);
      expect((await request('/api/digests/review-runs')).status).toBe(401);
      expect((await request('/api/digests/review-runs/missing')).status).toBe(401);

      const authorized = { authorization: 'Bearer review-route-key' };
      const options = await request('/api/digests/review-runs/options', { headers: authorized });
      expect(options.status).toBe(200);
      expect(options.body.defaults).toMatchObject({
        sourceMaxChars: 6000,
        commentaryMinWords: 80,
        commentaryMaxWords: 150,
      });
      expect(options.body.defaults.phase1Prompt).toEqual(expect.any(String));
      expect(options.body.defaults.phase2Prompt).toEqual(expect.any(String));
      expect((await request('/api/digests/review-runs', { headers: authorized }))).toMatchObject({
        status: 200,
        body: [],
      });
      expect((await request('/api/digests/review-runs/missing', { headers: authorized })).status).toBe(404);
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
      if (previousKey === undefined) delete process.env.API_SECRET_KEY;
      else process.env.API_SECRET_KEY = previousKey;
    }
  });

  it('lists summary counts, returns full Phase 1 details, and toggles inclusion only with a boolean', async () => {
    const { runId, itemId } = createAwaitingReviewRun();

    const list = await request('/api/digests/review-runs');
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({
      id: runId,
      status: 'awaiting_review',
      item_count: 1,
      selected_count: 1,
    });
    expect(list.body[0]).not.toHaveProperty('settings');
    expect(list.body[0]).not.toHaveProperty('items');

    const detail = await request(`/api/digests/review-runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.items[0]).toMatchObject({
      id: itemId,
      title: 'Original title',
      phase1_output: 'Finished first-pass commentary',
      included: 1,
    });

    expect((await request(`/api/digests/review-runs/${runId}/items/${itemId}`, {
      method: 'PATCH', body: { included: 'false' },
    })).status).toBe(400);
    const toggle = await request(`/api/digests/review-runs/${runId}/items/${itemId}`, {
      method: 'PATCH', body: { included: false },
    });
    expect(toggle.status).toBe(200);
    expect(toggle.body.item.included).toBe(0);
  });

  it('rejects missing or duplicate explicit articleIds before any model call', async () => {
    expect((await request('/api/digests/generate', {
      method: 'POST', body: { articleIds: 'missing' },
    })).status).toBe(400);
    expect((await request('/api/digests/generate', {
      method: 'POST', body: { settings: { sourceMaxChars: 99 } },
    })).status).toBe(400);
    expect((await request('/api/digests/generate', {
      method: 'POST', body: { articleIds: ['missing'] },
    })).status).toBe(400);
    expect((await request('/api/digests/generate', {
      method: 'POST', body: { articleIds: ['same', 'same'] },
    })).status).toBe(400);
  });

  it('exposes explicit no-spend recovery for interrupted Phase 1 and recorded Phase 2', async () => {
    const phase1 = createAwaitingReviewRun('phase1');
    getDb().prepare(
      `UPDATE digest_review_runs SET status = 'phase1_processing', phase1_completed_at = NULL
        WHERE id = ?`
    ).run(phase1.runId);
    getDb().prepare(
      `UPDATE digest_review_items
          SET phase1_status = 'pending', phase1_output = NULL, phase1_word_count = NULL
        WHERE id = ?`
    ).run(phase1.itemId);
    getDb().prepare(
      `UPDATE articles SET status = 'digest_review'
        WHERE id = (SELECT article_id FROM digest_review_items WHERE id = ?)`
    ).run(phase1.itemId);
    const phase1Attempt = claimDigestReviewPhase1Item(phase1.runId, phase1.itemId, {
      system: 's', user: 'u', vendor: 'openai', model: 'm', maxTokens: 100,
    });
    markDigestReviewPhase1CallStarted(phase1Attempt.id);

    const recoveredPhase1 = await request(
      `/api/digests/review-runs/${phase1.runId}/recover-phase1`,
      { method: 'POST' }
    );
    expect(recoveredPhase1).toMatchObject({
      status: 202,
      body: { runId: phase1.runId, status: 'phase1_attention_required' },
    });
    const skipped = await request(
      `/api/digests/review-runs/${phase1.runId}/items/${phase1.itemId}/resolve-phase1`,
      { method: 'POST', body: { action: 'skip' } }
    );
    expect(skipped).toMatchObject({ status: 202, body: { status: 'failed' } });

    const phase2 = createAwaitingReviewRun('phase2');
    freezeDigestReviewPhase2(phase2.runId);
    const claimed = claimDigestReviewPhase2(phase2.runId, {
      system: 's', user: 'u', vendor: 'openai', model: 'm', maxTokens: 100,
    });
    const attempt = claimed.phase2_attempts.at(-1);
    markDigestReviewPhase2CallStarted(attempt.id);
    recordDigestReviewPhase2Response(attempt.id, { content: '#новости 1. Saved' });
    const recoveredPhase2 = await request(
      `/api/digests/review-runs/${phase2.runId}/recover-phase2`,
      { method: 'POST' }
    );
    expect(recoveredPhase2.status).toBe(201);
    expect(recoveredPhase2.body).toMatchObject({ status: 'ready_for_review' });
    expect(getDigestReviewRun(phase2.runId).result_digest_id).toBe(recoveredPhase2.body.digestId);
  });

  it('requires explicit confirmation before a paid Phase 2 retry', async () => {
    const { runId } = createAwaitingReviewRun();
    expect((await request(`/api/digests/review-runs/${runId}/retry-phase2`, {
      method: 'POST', body: {},
    })).status).toBe(400);
  });

  it('refuses deletion when a digest is immutable rerun provenance', async () => {
    const digestId = createDigest({ date: '2026-08-02', articlesCount: 1 });
    createDigestReviewRun({
      sourceKind: 'rerun',
      sourceDigestId: digestId,
      sourceOrderKind: 'digest_order',
      settings: getDigestReviewOptions(config).defaults,
      articles: [{
        id: 'source-article',
        title: 'Frozen source',
        url: 'https://example.com/frozen',
        content: 'Frozen source content '.repeat(20),
      }],
    });

    const result = await request(`/api/digests/${digestId}`, { method: 'DELETE' });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/immutable review run/u);
  });
});
