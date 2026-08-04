import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { initDb, getDb, insertArticle } from '../db/index.js';
import articlesRouter from './articles.js';

// Server-side guard against the Perplexity SPA rendering ANOTHER article's text
// under a dead /page/ slug: PATCH must refuse content that already belongs to a
// different article. The router is driven over a real express server (native
// fetch, same style as the other route tests); no network leaves the process
// because every path here short-circuits before any fetch.

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/articles', articlesRouter);

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

beforeEach(() => {
  initDb(':memory:');
});

function seed({ url, title = '', content = '' }) {
  return insertArticle({ url, title, content, source: 'test' }).id;
}

function rowOf(id) {
  return getDb().prepare('SELECT * FROM articles WHERE id = ?').get(id);
}

async function patch(id, body) {
  const res = await fetch(`${base}/api/articles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Long enough that the 300-char prefix comparison is exercised on a real prefix.
const FOREIGN = 'Учёные обнаружили новый механизм регуляции клеточного метаболизма. '.repeat(10);
const UNIQUE = 'Совсем другая статья про запуск ракеты и орбитальную группировку. '.repeat(10);

describe('PATCH /api/articles/:id — duplicate content guard', () => {
  it('rejects content that duplicates another article and records a fetch failure', async () => {
    const donor = seed({ url: 'https://www.perplexity.ai/page/alive-1', content: FOREIGN });
    const victim = seed({ url: 'https://www.perplexity.ai/page/dead-1' });

    const { status, body } = await patch(victim, { title: 'Мёртвый слаг', content: FOREIGN });

    expect(status).toBe(409);
    expect(body.error).toBe('duplicate_content');
    expect(body.duplicateOf).toBe(donor);

    const row = rowOf(victim);
    expect(row.content || '').toBe('');
    expect(row.fetch_attempts).toBe(1);
    expect(row.fetch_error).toBe(`duplicate_content: matches ${donor}`);
  });

  it('only the first 300 chars need to match (tail divergence does not save it)', async () => {
    const donor = seed({ url: 'https://www.perplexity.ai/page/alive-2', content: FOREIGN });
    const victim = seed({ url: 'https://www.perplexity.ai/page/dead-2' });

    const { status, body } = await patch(victim, { content: `${FOREIGN}и ещё один абзац.` });

    expect(status).toBe(409);
    expect(body.duplicateOf).toBe(donor);
  });

  it('accepts unique content (regression guard for the normal path)', async () => {
    seed({ url: 'https://www.perplexity.ai/page/alive-3', content: FOREIGN });
    const target = seed({ url: 'https://www.perplexity.ai/page/fresh-3' });

    const { status, body } = await patch(target, { title: 'Ракеты', content: UNIQUE });

    expect(status).toBe(200);
    expect(body.content).toBe(UNIQUE);
    expect(rowOf(target).content).toBe(UNIQUE);
    expect(rowOf(target).fetch_attempts).toBe(0);
  });

  it('title-only PATCH is untouched by the guard', async () => {
    seed({ url: 'https://www.perplexity.ai/page/alive-4', content: FOREIGN });
    const target = seed({ url: 'https://www.perplexity.ai/page/titled-4', content: UNIQUE });

    const { status, body } = await patch(target, { title: 'Новый заголовок' });

    expect(status).toBe(200);
    expect(body.title).toBe('Новый заголовок');
    expect(rowOf(target).content).toBe(UNIQUE);
    expect(rowOf(target).fetch_attempts).toBe(0);
  });

  it('re-sending the same content to the SAME article is allowed (retry, not substitution)', async () => {
    const target = seed({ url: 'https://www.perplexity.ai/page/retry-5' });

    const first = await patch(target, { content: UNIQUE });
    expect(first.status).toBe(200);

    const second = await patch(target, { title: 'Уточнённый заголовок', content: UNIQUE });
    expect(second.status).toBe(200);
    expect(rowOf(target).content).toBe(UNIQUE);
    expect(rowOf(target).fetch_attempts).toBe(0);
  });
});
