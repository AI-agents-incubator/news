import { Router } from 'express';
import {
  insertArticle,
  getArticleCount,
  deleteArticle,
  recordFetchFailure,
  getDb,
} from '../db/index.js';
import { fetchArticleContent } from '../services/article-fetcher.js';
import { showFull, publicArticle, clampLimit } from './public-dto.js';
import { validateArticleUrl } from '../services/url-validator.js';
import config from '../config.js';

const router = Router();

// POST /api/articles — add single article by URL (fetches content)
router.post('/', async (req, res) => {
  try {
    const { url } = req.body;

    // Single-source URL validation (HTTPS + perplexity.ai + no control chars);
    // store only the normalized href.
    const v = validateArticleUrl(url);
    if (!v.ok) {
      return res.status(400).json({ error: v.error });
    }
    const href = v.href;

    const { title: providedTitle, content: providedContent } = req.body;
    let title = providedTitle || '';
    let content = providedContent || '';

    // If content was provided by client (e.g. iOS Shortcut), skip server-side fetch
    if (!content) {
      try {
        const fetched = await fetchArticleContent(href);
        title = fetched.title;
        content = fetched.content;
      } catch (fetchErr) {
        const result = insertArticle({ url: href, title, content: '', source: 'api' });
        if (!result.duplicate) {
          getDb().prepare(
            `UPDATE articles SET fetch_error = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(fetchErr.message, result.id);
        }
        return res.status(201).json({
          ...result,
          warning: `Content fetch failed: ${fetchErr.message}`,
        });
      }
    }

    const result = insertArticle({ url: href, title, content, source: 'api' });

    res.status(result.duplicate ? 200 : 201).json({
      id: result.id,
      url: result.url,
      title: result.title || title,
      status: result.status || 'new',
      duplicate: result.duplicate || false,
    });
  } catch (err) {
    console.error('[articles] POST / error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/articles/batch — add multiple articles with pre-fetched content
router.post('/batch', (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    let inserted = 0;
    let skipped = 0;
    const duplicates = [];
    const results = [];

    for (const item of items) {
      if (!item.url) {
        skipped++;
        continue;
      }

      // Same URL contract as the single-article path — batch was previously
      // unvalidated, letting untrusted/malformed URLs into the DB (and later
      // into the fetcher's AppleScript sink).
      const v = validateArticleUrl(item.url);
      if (!v.ok) {
        skipped++;
        continue;
      }

      const result = insertArticle({
        url: v.href,
        title: item.title || '',
        content: item.content || '',
        source: item.source || 'extension',
      });

      if (result.duplicate) {
        duplicates.push(item.url);
      } else {
        inserted++;
      }

      results.push({
        id: result.id,
        url: result.url,
        duplicate: result.duplicate || false,
      });
    }

    res.status(201).json({
      inserted,
      skipped,
      duplicates: duplicates.length,
      results,
    });
  } catch (err) {
    console.error('[articles] POST /batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/articles — list articles with optional filters
router.get('/', (req, res) => {
  try {
    const { status, limit } = req.query;
    const limitNum = clampLimit(limit, 50, 200);
    const db = getDb();

    let articles;
    if (status) {
      articles = db.prepare(
        'SELECT * FROM articles WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      ).all(status, limitNum);
    } else {
      articles = db.prepare(
        'SELECT * FROM articles ORDER BY created_at DESC LIMIT ?'
      ).all(limitNum);
    }

    res.json(showFull(req) ? articles : articles.map(publicArticle));
  } catch (err) {
    console.error('[articles] GET / error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/articles/stats — article counts by status
router.get('/stats', (req, res) => {
  try {
    res.json({
      new: getArticleCount('new'),
      processing: getArticleCount('processing'),
      used: getArticleCount('used'),
      error: getArticleCount('error'),
      total: getArticleCount(),
    });
  } catch (err) {
    console.error('[articles] GET /stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/articles/:id — update article fields (title, content)
// Used by local-fetcher.js to enrich articles with content from real Chrome
router.patch('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;
    const db = getDb();

    const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    // Second line of defence against the Perplexity SPA serving another
    // article's text under a dead /page/ slug: identical content on two
    // different articles is never legitimate. Across the whole corpus (1454
    // articles with content) matching first 300 chars produced exactly 3
    // groups, all of them contamination — zero false positives. Self-matches
    // (re-PATCHing the same article) are excluded by id <> ?, since re-sending
    // the same text to its own article is a normal retry, not a substitution.
    if (content) {
      const dup = db.prepare(
        `SELECT id FROM articles
          WHERE id <> ? AND content IS NOT NULL
            AND substr(content, 1, 300) = substr(?, 1, 300)
          LIMIT 1`
      ).get(id, content);
      if (dup) {
        // Route through the same failure path as /fetch-failed so the article
        // grows its attempt counter and eventually turns 'unfetchable' — the
        // problem stays visible in the DB/dashboard, not just in fetcher logs.
        recordFetchFailure(id, config.maxFetchAttempts, `duplicate_content: matches ${dup.id}`);
        return res.status(409).json({ error: 'duplicate_content', duplicateOf: dup.id });
      }
    }

    const updates = [];
    const values = [];

    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }
    if (content !== undefined) {
      updates.push('content = ?');
      values.push(content);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update. Send title and/or content.' });
    }

    updates.push("updated_at = datetime('now')");
    // Reset status and clear error if we got content. Also zero the failure
    // counter so a previously flaky article gets a clean slate once it succeeds.
    if (content) {
      updates.push('fetch_error = NULL');
      updates.push('fetch_attempts = 0');
      updates.push("status = 'new'");
    }

    values.push(id);
    db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    res.json(updated);
  } catch (err) {
    console.error('[articles] PATCH /:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/articles/:id/fetch-failed — the local fetcher reports a failed
// extraction attempt for this article. After config.maxFetchAttempts failures
// the article flips to the terminal 'unfetchable' status so the fetcher stops
// re-opening Chrome for it every cycle. Bearer-authenticated via the /api
// writeAuth mount (same credential the fetcher uses for PATCH).
router.post('/:id/fetch-failed', (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const result = recordFetchFailure(
      id,
      config.maxFetchAttempts,
      reason ? String(reason).slice(0, 300) : null
    );
    if (!result) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.json(result);
  } catch (err) {
    console.error('[articles] POST /:id/fetch-failed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/articles/:id
router.delete('/:id', (req, res) => {
  try {
    const result = deleteArticle(req.params.id);
    if (result.blockedByBatch) {
      return res.status(409).json({
        error: 'Article belongs to an immutable digest review batch',
        batchId: result.blockedByBatch.id,
        batchStatus: result.blockedByBatch.status,
      });
    }
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('[articles] DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
