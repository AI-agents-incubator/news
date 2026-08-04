import {
  claimReadyArticles,
  getDb,
  getDigestReviewRun,
  getOpenQueueDigestReviewRun,
} from '../db/index.js';
import { CLASSIC_DIGEST_TARGET_SIZE, generateDigest } from './digest-generator.js';
import { notifyDigestReviewReady } from './notifier.js';

let running = false;

export async function processQueue(config, {
  claimArticles = claimReadyArticles,
  getDatabase = getDb,
  generatePhase1 = generateDigest,
  getReviewRun = getDigestReviewRun,
  getOpenQueueRun = getOpenQueueDigestReviewRun,
  notifyReviewReady = notifyDigestReviewReady,
} = {}) {
  if (running) {
    return;
  }

  running = true;

  try {
    const openRun = getOpenQueueRun();
    if (openRun) {
      console.log(`[queue-manager] Existing Phase 1 run requires recovery: ${openRun.id}`);
      if (config.ntfyTopic) await notifyReviewReady(config.ntfyTopic, openRun);
      return;
    }

    const articles = claimArticles({
      limit: CLASSIC_DIGEST_TARGET_SIZE,
      threshold: CLASSIC_DIGEST_TARGET_SIZE,
      leaseMs: config.processingLeaseMs,
    });

    if (articles.length === 0) return;

    console.log(`[queue-manager] Running digest Phase 1 for ${articles.length} articles`);

    const db = getDatabase();
    const runId = await generatePhase1(db, articles, config, {
      leaseId: articles[0].processing_lease_id,
    });

    const run = getReviewRun(runId);
    console.log(`[queue-manager] Phase 1 finished with status ${run?.status || 'unknown'}: ${runId}`);

    if (config.ntfyTopic) {
      await notifyReviewReady(config.ntfyTopic, run);
    }
  } catch (err) {
    console.error('[queue-manager] Error processing queue:', err.message);
  } finally {
    running = false;
  }
}

export function startQueueManager(config) {
  console.log(`[queue-manager] Started (interval: ${config.checkIntervalMs}ms, exact batch size: ${CLASSIC_DIGEST_TARGET_SIZE})`);

  const intervalId = setInterval(() => processQueue(config), config.checkIntervalMs);

  // Run once immediately
  processQueue(config);

  return intervalId;
}
