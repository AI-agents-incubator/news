import { beforeEach, describe, expect, it } from 'vitest';
import { deleteArticle, getDb, initDb, insertArticle } from './index.js';

function addArticle(slug) {
  return insertArticle({
    url: `https://www.perplexity.ai/page/${slug}`,
    title: slug,
    content: 'source text',
  }).id;
}

function addArtifact(articleId, id = `artifact-${articleId}`) {
  getDb().prepare(
    `INSERT INTO article_stage_artifacts
       (id, article_id, stage, stage_version, input_sha256, root_input_sha256, prompt_sha256, status)
     VALUES (?, ?, 'styled_news', 'v4', 'input', 'root', 'prompt', 'succeeded')`
  ).run(id, articleId);
  return id;
}

describe('editorial v4 data compatibility', () => {
  beforeEach(() => initDb(':memory:'));

  it('removes orphaned v4 stage receipts before deleting an article', () => {
    const articleId = addArticle('orphaned-receipt');
    addArtifact(articleId);

    expect(deleteArticle(articleId)).toMatchObject({ changes: 1 });
    expect(getDb().prepare('SELECT id FROM articles WHERE id = ?').get(articleId)).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM article_stage_artifacts WHERE article_id = ?').get(articleId)).toBeUndefined();
  });

  it('protects articles that belong to an immutable v4 review batch', () => {
    const articleId = addArticle('review-batch');
    const artifactId = addArtifact(articleId);
    getDb().prepare(
      `INSERT INTO digest_batches (id, status, target_size) VALUES ('batch-1', 'ready_for_review', 30)`
    ).run();
    getDb().prepare(
      `INSERT INTO digest_batch_items (batch_id, article_id, position, final_artifact_id, content)
       VALUES ('batch-1', ?, 1, ?, 'review copy')`
    ).run(articleId, artifactId);

    expect(deleteArticle(articleId)).toMatchObject({
      changes: 0,
      blockedByBatch: { id: 'batch-1', status: 'ready_for_review' },
    });
    expect(getDb().prepare('SELECT id FROM articles WHERE id = ?').get(articleId)).toBeTruthy();
  });
});
