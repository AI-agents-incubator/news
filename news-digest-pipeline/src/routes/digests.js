import { Router } from 'express';
import {
  getDigest,
  getDigests,
  getNewArticles,
  getArticlesByDigestId,
} from '../db/index.js';
import { generateDigest } from '../services/digest-generator.js';
import { publishDigest } from '../services/publishers/index.js';
import { getDb } from '../db/index.js';
import config from '../config.js';

const router = Router();

// POST /api/digests/generate — manual trigger
router.post('/generate', async (req, res) => {
  try {
    const { articleIds } = req.body || {};

    let articles;
    if (Array.isArray(articleIds) && articleIds.length > 0) {
      const db = getDb();
      const placeholders = articleIds.map(() => '?').join(',');
      articles = db.prepare(
        `SELECT * FROM articles WHERE id IN (${placeholders})`
      ).all(...articleIds);
    } else {
      articles = getNewArticles(config.maxArticlesPerDigest);
    }

    if (articles.length === 0) {
      return res.status(400).json({ error: 'No articles available for digest generation' });
    }

    const db = getDb();
    const digestId = await generateDigest(db, articles, config);

    res.status(201).json({ digestId });
  } catch (err) {
    console.error('[digests] POST /generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/digests — list digests
router.get('/', (req, res) => {
  try {
    const { status } = req.query;
    const filters = {};
    if (status) filters.status = status;

    const digests = getDigests(filters);
    res.json(digests);
  } catch (err) {
    console.error('[digests] GET / error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/digests/latest/text — latest digest as plain text
router.get('/latest/text', (req, res) => {
  try {
    const digests = getDigests();
    if (digests.length === 0) {
      return res.status(404).send('No digests yet');
    }
    const latest = digests[0];
    if (!latest.content) {
      return res.status(400).send('Latest digest has no content yet');
    }
    res.type('text/plain; charset=utf-8').send(latest.content);
  } catch (err) {
    console.error('[digests] GET /latest/text error:', err);
    res.status(500).send(err.message);
  }
});

// GET /api/digests/:id — single digest with articles
router.get('/:id', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const articles = getArticlesByDigestId(digest.id);

    res.json({ ...digest, articles });
  } catch (err) {
    console.error('[digests] GET /:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/digests/:id/text — plain text for copy-paste
router.get('/:id/text', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }
    if (!digest.content) {
      return res.status(400).send('Digest has no content yet');
    }
    res.type('text/plain; charset=utf-8').send(digest.content);
  } catch (err) {
    console.error('[digests] GET /:id/text error:', err);
    res.status(500).send(err.message);
  }
});

// POST /api/digests/:id/publish — publish to enabled platforms
router.post('/:id/publish', async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    if (!digest.content) {
      return res.status(400).json({ error: 'Digest has no content to publish' });
    }

    const results = await publishDigest(digest, config);
    res.json({ digestId: digest.id, published: results });
  } catch (err) {
    console.error('[digests] POST /:id/publish error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/digests/:id/mark-copied — mark digest as copied
router.patch('/:id/mark-copied', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const db = getDb();
    db.prepare(
      `UPDATE digests SET status = 'copied', updated_at = datetime('now') WHERE id = ?`
    ).run(req.params.id);

    res.json({ ok: true, id: req.params.id, status: 'copied' });
  } catch (err) {
    console.error('[digests] PATCH /:id/mark-copied error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/digests/:id/status — update digest status (draft/published)
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !['draft', 'published'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "draft" or "published"' });
    }

    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const db = getDb();
    if (status === 'published') {
      db.prepare(
        `UPDATE digests SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(req.params.id);
    } else {
      db.prepare(
        `UPDATE digests SET status = 'draft', published_at = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(req.params.id);
    }

    const updated = getDigest(req.params.id);
    res.json({ ok: true, id: req.params.id, status: updated.status, published_at: updated.published_at });
  } catch (err) {
    console.error('[digests] PATCH /:id/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
