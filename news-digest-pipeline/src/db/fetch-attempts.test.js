import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, insertArticle, recordFetchFailure, getNewArticles } from './index.js';

// recordFetchFailure is the structural fix for the endless "Chrome re-opens the
// same article every 5 minutes" loop: after N failures an article leaves the
// fetch pool for good ('unfetchable'), so it can never be re-selected.

function statusOf(id) {
  return getDb().prepare('SELECT status, fetch_attempts FROM articles WHERE id = ?').get(id);
}

describe('recordFetchFailure — attempt cap → unfetchable', () => {
  let id;
  beforeEach(() => {
    initDb(':memory:');
    const r = insertArticle({ url: 'https://www.perplexity.ai/page/dead-xxxx', title: '', content: '' });
    id = r.id;
  });

  it('increments attempts without capping below the threshold', () => {
    const r1 = recordFetchFailure(id, 3);
    expect(r1.attempts).toBe(1);
    expect(r1.capped).toBe(false);
    expect(statusOf(id).status).toBe('new');

    const r2 = recordFetchFailure(id, 3);
    expect(r2.attempts).toBe(2);
    expect(r2.capped).toBe(false);
    expect(statusOf(id).status).toBe('new');
  });

  it('flips to unfetchable once attempts reach maxAttempts', () => {
    recordFetchFailure(id, 3);
    recordFetchFailure(id, 3);
    const r3 = recordFetchFailure(id, 3);
    expect(r3.attempts).toBe(3);
    expect(r3.capped).toBe(true);
    expect(r3.status).toBe('unfetchable');
    expect(statusOf(id).status).toBe('unfetchable');
  });

  it('unfetchable articles drop out of the fetch/digest pool (getNewArticles)', () => {
    // Capped article must not be returned as a "new" article anymore.
    for (let i = 0; i < 5; i++) recordFetchFailure(id, 5);
    expect(statusOf(id).status).toBe('unfetchable');
    const news = getNewArticles(50);
    expect(news.find((a) => a.id === id)).toBeUndefined();
  });

  it('stores the last failure reason', () => {
    recordFetchFailure(id, 5, 'empty_source: 0 chars');
    expect(getDb().prepare('SELECT fetch_error FROM articles WHERE id = ?').get(id).fetch_error)
      .toBe('empty_source: 0 chars');
  });

  it('returns null for a missing article', () => {
    expect(recordFetchFailure('no-such-id', 5)).toBeNull();
  });
});
