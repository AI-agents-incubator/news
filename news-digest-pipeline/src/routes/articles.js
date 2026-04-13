import { Router } from 'express';
import {
  insertArticle,
  getArticleCount,
  deleteArticle,
  getDb,
} from '../db/index.js';
import { fetchArticleContent } from '../services/article-fetcher.js';

const router = Router();

// POST /api/articles — add single article by URL (fetches content)
router.post('/', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const { title: providedTitle, content: providedContent } = req.body;
    let title = providedTitle || '';
    let content = providedContent || '';

    // If content was provided by client (e.g. iOS Shortcut), skip server-side fetch
    if (!content) {
      try {
        const fetched = await fetchArticleContent(url);
        title = fetched.title;
        content = fetched.content;
      } catch (fetchErr) {
        const result = insertArticle({ url, title, content: '', source: 'api' });
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

    const result = insertArticle({ url, title, content, source: 'api' });

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

      const result = insertArticle({
        url: item.url,
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
    const limitNum = parseInt(limit || '50', 10);
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

    res.json(articles);
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
    // Reset status and clear error if we got content
    if (content) {
      updates.push('fetch_error = NULL');
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

// DELETE /api/articles/:id
router.delete('/:id', (req, res) => {
  try {
    const result = deleteArticle(req.params.id);
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
