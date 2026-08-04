import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDb,
  insertArticle,
  getReadyArticles,
  getReadyArticleCount,
  claimReadyArticles,
  updateClaimedArticleCommentary,
  failClaimedArticle,
  createClaimedDigest,
  getDigest,
  getDb,
  MIN_READY_ARTICLE_CONTENT_CHARS,
} from './index.js';

describe('automatic digest eligibility', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('excludes URL-only and placeholder rows while preserving ready articles', () => {
    const empty = insertArticle({ url: 'https://www.perplexity.ai/page/empty', content: '' }).id;
    const whitespace = insertArticle({ url: 'https://www.perplexity.ai/page/whitespace', content: '   \n\t' }).id;
    const short = insertArticle({
      url: 'https://www.perplexity.ai/page/short',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS - 1),
    }).id;
    const ready = insertArticle({
      url: 'https://www.perplexity.ai/page/ready',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id;

    expect(getReadyArticleCount()).toBe(1);
    expect(getReadyArticles(10).map((article) => article.id)).toEqual([ready]);
    expect(getReadyArticles(10).map((article) => article.id)).not.toContain(empty);
    expect(getReadyArticles(10).map((article) => article.id)).not.toContain(whitespace);
    expect(getReadyArticles(10).map((article) => article.id)).not.toContain(short);
  });

  it('atomically claims only ready rows and leaves them processing', () => {
    const empty = insertArticle({
      url: 'https://www.perplexity.ai/page/claim-empty',
      content: '',
    }).id;
    const short = insertArticle({
      url: 'https://www.perplexity.ai/page/claim-short',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS - 1),
    }).id;
    const ready = insertArticle({
      url: 'https://www.perplexity.ai/page/claim-ready',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id;

    const claimed = claimReadyArticles({ limit: 10 });

    expect(claimed.map((article) => article.id)).toEqual([ready]);
    expect(claimed[0].status).toBe('processing');
    expect(claimed[0].processing_lease_id).toEqual(expect.any(String));
    expect(claimed[0].processing_lease_expires_at).toBeGreaterThan(Date.now());
    const rows = getDb().prepare(
      'SELECT id, status, processing_lease_id, processing_lease_expires_at FROM articles ORDER BY url ASC'
    ).all();
    expect(rows.find((article) => article.id === ready).status).toBe('processing');
    expect(rows.find((article) => article.id === ready).processing_lease_id).toBe(claimed[0].processing_lease_id);
    expect(rows.find((article) => article.id === empty).status).toBe('new');
    expect(rows.find((article) => article.id === short).status).toBe('new');
  });

  it('does not return the same claimed row to a second trigger', () => {
    const ready = insertArticle({
      url: 'https://www.perplexity.ai/page/claim-once',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id;

    expect(claimReadyArticles({ limit: 10 }).map((article) => article.id)).toEqual([ready]);
    expect(claimReadyArticles({ limit: 10 })).toEqual([]);
  });

  it('does not claim a partial queue batch below its threshold', () => {
    const readyIds = [1, 2].map((n) => insertArticle({
      url: `https://www.perplexity.ai/page/threshold-${n}`,
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id);

    expect(claimReadyArticles({ limit: 10, threshold: 3 })).toEqual([]);
    const rows = getDb().prepare('SELECT id, status FROM articles ORDER BY url ASC').all();
    expect(rows.map((article) => article.id).sort()).toEqual([...readyIds].sort());
    expect(rows.every((article) => article.status === 'new')).toBe(true);
  });

  it('recovers an expired claim and rejects writes from its former worker', () => {
    const id = insertArticle({
      url: 'https://www.perplexity.ai/page/reclaim-expired',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id;
    const firstClaim = claimReadyArticles({ limit: 10, leaseMs: 60_000 });
    const oldLeaseId = firstClaim[0].processing_lease_id;

    getDb().prepare(
      'UPDATE articles SET processing_lease_expires_at = ? WHERE id = ?'
    ).run(Date.now() - 1, id);

    const recoveredClaim = claimReadyArticles({ limit: 10, leaseMs: 60_000 });
    const newLeaseId = recoveredClaim[0].processing_lease_id;

    expect(recoveredClaim.map((article) => article.id)).toEqual([id]);
    expect(newLeaseId).not.toBe(oldLeaseId);
    expect(updateClaimedArticleCommentary(id, 'stale write', oldLeaseId)).toBe(false);
    expect(failClaimedArticle(id, oldLeaseId)).toBe(false);

    const row = getDb().prepare(
      'SELECT status, commentary, processing_lease_id FROM articles WHERE id = ?'
    ).get(id);
    expect(row).toMatchObject({
      status: 'processing',
      commentary: null,
      processing_lease_id: newLeaseId,
    });
  });

  it('creates a leased digest atomically and clears its article lease', () => {
    const id = insertArticle({
      url: 'https://www.perplexity.ai/page/finalize-lease',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id;
    const [claimed] = claimReadyArticles({ limit: 10, leaseMs: 60_000 });

    const digestId = createClaimedDigest({
      date: '2026-07-19',
      articlesCount: 1,
      content: '#новости\n\nТестовый дайджест',
      generationLog: 'test',
      model: 'test-model',
    }, [id], claimed.processing_lease_id);

    expect(getDigest(digestId)).toMatchObject({
      id: digestId,
      content: '#новости\n\nТестовый дайджест',
      status: 'draft',
    });
    expect(getDb().prepare(
      'SELECT digest_id, status, processing_lease_id, processing_lease_expires_at FROM articles WHERE id = ?'
    ).get(id)).toMatchObject({
      digest_id: digestId,
      status: 'used',
      processing_lease_id: null,
      processing_lease_expires_at: null,
    });
  });

  it('does not create an orphan digest when an old lease tries to finalize', () => {
    const id = insertArticle({
      url: 'https://www.perplexity.ai/page/stale-finalize',
      content: 'x'.repeat(MIN_READY_ARTICLE_CONTENT_CHARS),
    }).id;
    const [firstClaim] = claimReadyArticles({ limit: 10, leaseMs: 60_000 });
    getDb().prepare(
      'UPDATE articles SET processing_lease_expires_at = ? WHERE id = ?'
    ).run(Date.now() - 1, id);
    claimReadyArticles({ limit: 10, leaseMs: 60_000 });

    expect(() => createClaimedDigest({
      date: '2026-07-19',
      articlesCount: 1,
      content: '#новости\n\nУстаревший дайджест',
      generationLog: 'old worker',
      model: 'test-model',
    }, [id], firstClaim.processing_lease_id)).toThrow('Processing lease lost');
    expect(getDb().prepare('SELECT COUNT(*) as count FROM digests').get().count).toBe(0);
  });
});
