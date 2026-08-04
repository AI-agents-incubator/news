import { describe, expect, it, vi } from 'vitest';
import { processQueue } from './queue-manager.js';

describe('digest review queue hand-off', () => {
  it('runs Phase 1 only and reports an awaiting-review run', async () => {
    const articles = Array.from({ length: 30 }, (_, index) => ({
      id: `article-${index + 1}`,
      processing_lease_id: 'lease-1',
    }));
    const generatePhase1 = vi.fn().mockResolvedValue('run-1');
    const notifyReviewReady = vi.fn().mockResolvedValue(null);

    await processQueue({
      processingLeaseMs: 60_000,
      ntfyTopic: 'test-topic',
    }, {
      claimArticles: vi.fn().mockReturnValue(articles),
      getDatabase: vi.fn().mockReturnValue({}),
      generatePhase1,
      getReviewRun: vi.fn().mockReturnValue({
        id: 'run-1',
        status: 'awaiting_review',
        items_count: 30,
      }),
      getOpenQueueRun: vi.fn().mockReturnValue(null),
      notifyReviewReady,
    });

    expect(generatePhase1).toHaveBeenCalledTimes(1);
    expect(generatePhase1).toHaveBeenCalledWith({}, articles, expect.any(Object), {
      leaseId: 'lease-1',
    });
    expect(notifyReviewReady).toHaveBeenCalledWith('test-topic', expect.objectContaining({
      id: 'run-1',
      status: 'awaiting_review',
    }));
  });

  it('does not claim a second batch while a Phase 1 run needs recovery', async () => {
    const openRun = { id: 'run-open', status: 'phase1_attention_required', items: [] };
    const claimArticles = vi.fn();
    const generatePhase1 = vi.fn();
    const notifyReviewReady = vi.fn().mockResolvedValue(null);

    await processQueue({ processingLeaseMs: 60_000, ntfyTopic: 'test-topic' }, {
      claimArticles,
      getOpenQueueRun: vi.fn().mockReturnValue(openRun),
      generatePhase1,
      notifyReviewReady,
    });

    expect(claimArticles).not.toHaveBeenCalled();
    expect(generatePhase1).not.toHaveBeenCalled();
    expect(notifyReviewReady).toHaveBeenCalledWith('test-topic', openRun);
  });
});
