import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyDigestReviewReady } from './notifier.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('digest review notifications', () => {
  it('names a failed Phase 1 run truthfully without sending a real request', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await notifyDigestReviewReady('test-topic', {
      id: 'run-failed',
      status: 'failed',
      item_count: 30,
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers.Title).toBe('Digest Phase 1 Failed');
    expect(options.body).toContain('run-failed');
    expect(options.body).not.toContain('before assembling');
  });

  it('labels an interrupted run as recovery-required without claiming completion', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    await notifyDigestReviewReady('test-topic', {
      id: 'run-attention', status: 'phase1_attention_required', item_count: 30,
    });

    const [, options] = globalThis.fetch.mock.calls[0];
    expect(options.headers.Title).toBe('Digest Phase 1 Needs Recovery');
    expect(options.body).toContain('no automatic model retry');
    expect(options.body).not.toContain('Phase 1 completed');
  });
});
