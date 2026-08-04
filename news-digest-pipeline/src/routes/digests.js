import { Router } from 'express';
import {
  getDigest,
  getDigests,
  claimReadyArticles,
  getArticlesByDigestId,
  getLatestDigestStageArtifact,
  getDigestReviewRun,
  listDigestReviewRuns,
  setDigestReviewItemIncluded,
  isDigestReferencedByReviewRun,
} from '../db/index.js';
import {
  CLASSIC_DIGEST_TARGET_SIZE,
  generateDigest,
  createDigestRerun,
  assembleDigestReviewRun,
  getDigestReviewOptions,
  normalizeDigestReviewSettings,
  recoverDigestReviewPhase1Run,
  recoverDigestReviewPhase2Run,
  resolveDigestReviewPhase1RunItem,
} from '../services/digest-generator.js';
import { publishDigest } from '../services/publishers/index.js';
import { getDb } from '../db/index.js';
import config from '../config.js';
import { showFull, publicDigest, publicArticle, clampLimit } from './public-dto.js';
import { existingDigestCardImagePath } from '../services/digest-card-store.js';
import { operatorAuth } from '../middleware/auth.js';

// Kept as data here so the public/open-core API can still report a stored
// receipt even when the private image-preparation module is deliberately not
// present in that build.
const INSTAGRAM_CARD_STAGE = 'instagram_top5_hook_card';
const INSTAGRAM_CARD_STAGE_VERSION = 'top5-hook.v4';
let digestInstagramCardService;
let digestInstagramCarouselService;
let digestInstagramRepublicationService;

async function loadDigestInstagramCardService() {
  if (digestInstagramCardService === undefined) {
    try {
      digestInstagramCardService = await import('../pro/services/digest-instagram-card.js');
    } catch (error) {
      if (/Cannot find module|ERR_MODULE_NOT_FOUND/u.test(String(error?.message || error))) {
        digestInstagramCardService = null;
      } else {
        throw error;
      }
    }
  }
  return digestInstagramCardService;
}

// The digest carousel is an optional pro capability. Core deliberately loads
// it lazily so an open-core install has no accidental Instagram write path.
async function loadDigestInstagramCarouselService() {
  if (digestInstagramCarouselService === undefined) {
    try {
      digestInstagramCarouselService = await import('../pro/services/digest-instagram-carousel.js');
    } catch (error) {
      if (/Cannot find module|ERR_MODULE_NOT_FOUND/u.test(String(error?.message || error))) {
        digestInstagramCarouselService = null;
      } else {
        throw error;
      }
    }
  }
  return digestInstagramCarouselService;
}

async function loadDigestInstagramRepublicationService() {
  if (digestInstagramRepublicationService === undefined) {
    try {
      digestInstagramRepublicationService = await import('../pro/services/digest-instagram-republication.js');
    } catch (error) {
      if (/Cannot find module|ERR_MODULE_NOT_FOUND/u.test(String(error?.message || error))) {
        digestInstagramRepublicationService = null;
      } else {
        throw error;
      }
    }
  }
  return digestInstagramRepublicationService;
}

const router = Router();

// POST /api/digests/generate — manual trigger
router.post('/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const { articleIds } = body;
    if (articleIds !== undefined && !Array.isArray(articleIds)) {
      return res.status(400).json({ error: 'articleIds must be an array' });
    }
    const settings = body.settings ?? body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }
    let normalizedSettings;
    try {
      normalizedSettings = normalizeDigestReviewSettings(config, settings || {});
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    let articles;
    let leaseId = null;
    let sourceKind = 'queue';
    let sourceOrderKind = 'claimed_order';
    if (Array.isArray(articleIds) && articleIds.length > 0) {
      if (new Set(articleIds).size !== articleIds.length
        || articleIds.some((id) => typeof id !== 'string' || !id)) {
        return res.status(400).json({ error: 'articleIds must contain unique non-empty strings' });
      }
      const selectedDb = getDb();
      const placeholders = articleIds.map(() => '?').join(',');
      const rows = selectedDb.prepare(
        `SELECT * FROM articles WHERE id IN (${placeholders})`
      ).all(...articleIds);
      const byId = new Map(rows.map((article) => [article.id, article]));
      if (byId.size !== articleIds.length) {
        return res.status(400).json({ error: 'One or more requested articles do not exist' });
      }
      articles = articleIds.map((id) => byId.get(id));
      sourceKind = 'manual';
      sourceOrderKind = 'requested_order';
    } else {
      articles = claimReadyArticles({
        limit: CLASSIC_DIGEST_TARGET_SIZE,
        threshold: CLASSIC_DIGEST_TARGET_SIZE,
        leaseMs: config.processingLeaseMs,
      });
      leaseId = articles[0]?.processing_lease_id || null;
    }

    if (articles.length === 0) {
      return res.status(400).json({ error: 'No articles available for digest generation' });
    }

    const db = getDb();
    const runId = await generateDigest(db, articles, config, {
      leaseId,
      settings: normalizedSettings,
      sourceKind,
      sourceOrderKind,
    });
    const run = getDigestReviewRun(runId);

    res.status(202).json({ runId, status: run?.status || 'failed' });
  } catch (err) {
    console.error('[digests] POST /generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/digests — list digests. The owner sees full rows (unbounded, as the
// dashboard expects); anonymous callers get a capped, redacted list.
router.get('/', (req, res) => {
  try {
    const { status } = req.query;
    const filters = {};
    if (status) filters.status = status;

    if (showFull(req)) {
      return res.json(getDigests(filters));
    }
    filters.limit = clampLimit(req.query.limit, 100, 100);
    res.json(getDigests(filters).map(publicDigest));
  } catch (err) {
    console.error('[digests] GET / error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/digests/latest/text — latest digest as plain text
router.get('/latest/text', (req, res) => {
  try {
    const digests = getDigests({ limit: 1 });
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

// Digest review runs contain prompt snapshots and model routing details. Keep
// every read as well as every mutation behind operator auth, even though the
// legacy digest list remains publicly readable in redacted form.
router.get('/review-runs/options', operatorAuth, (req, res) => {
  try {
    res.json(getDigestReviewOptions(config));
  } catch (err) {
    console.error('[digests] GET /review-runs/options error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/review-runs', operatorAuth, (req, res) => {
  try {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, 100)
      : 20;
    res.json(listDigestReviewRuns(limit));
  } catch (err) {
    console.error('[digests] GET /review-runs error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/review-runs/:runId', operatorAuth, (req, res) => {
  try {
    const run = getDigestReviewRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Digest review run not found' });
    return res.json(run);
  } catch (err) {
    console.error('[digests] GET /review-runs/:runId error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/review-runs/from-digest/:digestId', operatorAuth, async (req, res) => {
  try {
    if (!getDigest(req.params.digestId)) {
      return res.status(404).json({ error: 'Digest not found' });
    }
    const settings = req.body?.settings ?? req.body ?? {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object' });
    }
    const runId = await createDigestRerun(getDb(), req.params.digestId, config, settings);
    const run = getDigestReviewRun(runId);
    return res.status(202).json({ runId, status: run?.status || 'failed' });
  } catch (err) {
    console.error('[digests] POST /review-runs/from-digest/:digestId error:', err);
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/review-runs/:runId/items/:itemId', operatorAuth, (req, res) => {
  try {
    if (typeof req.body?.included !== 'boolean') {
      return res.status(400).json({ error: 'included must be a boolean' });
    }
    const run = getDigestReviewRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Digest review run not found' });
    if (!run.items.some((item) => item.id === req.params.itemId)) {
      return res.status(404).json({ error: 'Digest review item not found' });
    }
    const item = setDigestReviewItemIncluded(
      req.params.runId,
      req.params.itemId,
      req.body.included
    );
    return res.json({ runId: req.params.runId, item });
  } catch (err) {
    console.error('[digests] PATCH /review-runs/:runId/items/:itemId error:', err);
    return res.status(409).json({ error: err.message });
  }
});

router.post('/review-runs/:runId/recover-phase1', operatorAuth, async (req, res) => {
  try {
    const run = getDigestReviewRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Digest review run not found' });
    const recovered = await recoverDigestReviewPhase1Run(getDb(), run.id, config);
    return res.status(202).json({ runId: run.id, status: recovered.status });
  } catch (err) {
    console.error('[digests] POST /review-runs/:runId/recover-phase1 error:', err);
    return res.status(409).json({ error: err.message });
  }
});

router.post('/review-runs/:runId/items/:itemId/resolve-phase1', operatorAuth, async (req, res) => {
  try {
    const run = getDigestReviewRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Digest review run not found' });
    const action = req.body?.action;
    if (!['skip', 'retry'].includes(action)) {
      return res.status(400).json({ error: 'action must be skip or retry' });
    }
    const resolved = await resolveDigestReviewPhase1RunItem(
      getDb(), run.id, req.params.itemId, config, {
        action,
        confirmPossibleDuplicateCost: req.body?.confirmPossibleDuplicateCost === true,
      }
    );
    return res.status(202).json({ runId: run.id, status: resolved.status });
  } catch (err) {
    console.error('[digests] POST /review-runs/:runId/items/:itemId/resolve-phase1 error:', err);
    return res.status(409).json({ error: err.message });
  }
});

router.post('/review-runs/:runId/assemble', operatorAuth, async (req, res) => {
  try {
    const before = getDigestReviewRun(req.params.runId);
    if (!before) return res.status(404).json({ error: 'Digest review run not found' });
    if (before.result_digest_id) {
      return res.status(200).json({
        runId: before.id,
        digestId: before.result_digest_id,
        status: 'ready_for_review',
      });
    }
    const digestId = await assembleDigestReviewRun(getDb(), req.params.runId, config);
    return res.status(201).json({
      runId: req.params.runId,
      digestId,
      status: 'ready_for_review',
    });
  } catch (err) {
    console.error('[digests] POST /review-runs/:runId/assemble error:', err);
    return res.status(409).json({ error: err.message });
  }
});

router.post('/review-runs/:runId/retry-phase2', operatorAuth, async (req, res) => {
  try {
    if (req.body?.confirmPaidRetry !== true) {
      return res.status(400).json({ error: 'confirmPaidRetry must be true' });
    }
    const run = getDigestReviewRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Digest review run not found' });
    const digestId = await assembleDigestReviewRun(getDb(), run.id, config, { confirmRetry: true });
    return res.status(201).json({ runId: run.id, digestId, status: 'ready_for_review' });
  } catch (err) {
    console.error('[digests] POST /review-runs/:runId/retry-phase2 error:', err);
    return res.status(409).json({ error: err.message });
  }
});

router.post('/review-runs/:runId/recover-phase2', operatorAuth, (req, res) => {
  try {
    const run = getDigestReviewRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Digest review run not found' });
    const digestId = recoverDigestReviewPhase2Run(getDb(), run.id);
    const recovered = getDigestReviewRun(run.id);
    return res.status(digestId ? 201 : 202).json({
      runId: run.id,
      digestId,
      status: recovered.status,
    });
  } catch (err) {
    console.error('[digests] POST /review-runs/:runId/recover-phase2 error:', err);
    return res.status(409).json({ error: err.message });
  }
});

function instagramCardDto(artifact) {
  if (!artifact) return null;
  let card = null;
  try {
    card = artifact.result_json ? JSON.parse(artifact.result_json) : null;
  } catch {
    // The raw response remains in the protected receipt; a malformed legacy
    // row must not make the digest endpoint fail.
  }
  const imageReady = artifact.status === 'succeeded'
    && !!existingDigestCardImagePath(config, artifact.image_file);
  return {
    id: artifact.id,
    stage: artifact.stage,
    version: artifact.stage_version,
    attempt: artifact.attempt,
    status: artifact.status,
    card,
    image_url: imageReady ? `/digest-card-images/${artifact.image_file}` : null,
    image_sha256: artifact.image_sha256,
    image_width: artifact.image_width,
    image_height: artifact.image_height,
    input_tokens: artifact.input_tokens,
    output_tokens: artifact.output_tokens,
    cost_usd: artifact.cost_usd,
    accounting_status: artifact.accounting_status,
    error: artifact.error,
    created_at: artifact.created_at,
  };
}

const CAROUSEL_PREPARATION_STATES = new Set(['not_prepared', 'preparing', 'ready', 'blocked', 'failed']);
const CAROUSEL_DELIVERY_STATES = new Set([
  'not_started', 'publishing', 'partial', 'awaiting_reconciliation', 'published', 'blocked', 'inconclusive',
]);
const CAROUSEL_RECEIPT_STATES = new Set([
  'intent', 'accepted', 'unknown', 'reconciled', 'failed', 'ambiguous', 'inconclusive',
]);

function safeCarouselState(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function noInstagramLinks(text) {
  return !/(?:https?:\/\/|www\.)/iu.test(text)
    && !/link\s+in\s+(?:bio|profile)|ссылк(?:а|и)\s+в\s+профил/iu.test(text);
}

function carouselTextDto(parts) {
  if (!Array.isArray(parts) || parts.length < 1) {
    return { valid: false, caption: null, comments: [] };
  }
  const ordered = [...parts].sort((a, b) => Number(a?.partIndex) - Number(b?.partIndex));
  const expected = ordered.every((part, index) => Number(part?.partIndex) === index
    && (index === 0 ? part.kind === 'caption' : part.kind === 'comment')
    && typeof part.text === 'string'
    && noInstagramLinks(part.text));
  if (!expected) return { valid: false, caption: null, comments: [] };
  return {
    valid: true,
    caption: ordered[0].text,
    comments: ordered.slice(1).map((part) => part.text),
  };
}

function carouselAssetsDto(assets) {
  if (!Array.isArray(assets) || assets.length !== 10) {
    return { valid: false, assets: [] };
  }
  const ordered = [...assets].sort((a, b) => Number(a?.slot) - Number(b?.slot));
  const sourceNumbers = new Set();
  const valid = ordered.every((asset, index) => {
    if (Number(asset?.slot) !== index
      || Number(asset?.imageWidth) !== 1080
      || Number(asset?.imageHeight) !== 1350
      || !existingDigestCardImagePath(config, asset?.imageFile)) {
      return false;
    }
    if (index === 0) return asset.role === 'cover' && asset.sourceNumber == null;
    const sourceNumber = Number(asset.sourceNumber);
    if (asset.role !== 'item' || !Number.isSafeInteger(sourceNumber) || sourceNumbers.has(sourceNumber)) {
      return false;
    }
    sourceNumbers.add(sourceNumber);
    return true;
  });
  if (!valid) return { valid: false, assets: [] };
  return {
    valid: true,
    assets: ordered.map((asset, index) => ({
      position: index + 1,
      role: asset.role === 'cover' ? 'cover' : 'item',
      asset_url: `/digest-card-images/${asset.imageFile}`,
    })),
  };
}

function carouselReceiptSummary(receipts, providedSummary) {
  const counts = {
    total: 0,
    intent: 0,
    accepted: 0,
    unknown: 0,
    reconciled: 0,
    failed: 0,
    ambiguous: 0,
    inconclusive: 0,
  };
  if (Array.isArray(receipts)) {
    for (const receipt of receipts) {
      const state = receipt?.state;
      if (!CAROUSEL_RECEIPT_STATES.has(state)) continue;
      counts.total += 1;
      counts[state] += 1;
    }
    return counts;
  }
  for (const key of Object.keys(counts)) {
    const value = Number(providedSummary?.[key]);
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return counts;
}

function carouselCommentDeliveryDto(raw, receipts, comments) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const topology = value.topology === 'threaded_replies' ? 'threaded_replies' : 'top_level_comments';
  const rootPartIndex = Number(value.rootPartIndex ?? value.root_part_index);
  const replyPartIndexes = Array.isArray(value.replyPartIndexes ?? value.reply_part_indexes)
    ? (value.replyPartIndexes ?? value.reply_part_indexes)
      .filter((part) => Number.isSafeInteger(Number(part)) && Number(part) > 1)
      .map(Number)
    : [];
  const allowedOperations = new Set(['media_publish', 'comment', 'comment_reply']);
  const receiptOperations = Array.isArray(receipts)
    ? receipts
      .filter((receipt) => allowedOperations.has(receipt?.operation) && Number.isSafeInteger(receipt?.ordinal))
      .map((receipt) => ({ operation: receipt.operation, ordinal: receipt.ordinal, state: receipt.state }))
    : [];
  return {
    topology,
    root_part_index: topology === 'threaded_replies' && rootPartIndex === 1 ? 1 : null,
    reply_part_indexes: topology === 'threaded_replies' ? replyPartIndexes : [],
    // Sanitized checkpoint identities: no text, remote id, request or token.
    receipt_operations: receiptOperations,
    final_live_visual_confirmation_required: topology === 'threaded_replies' && Array.isArray(comments) && comments.length > 0,
  };
}

// Never return raw model/provider records from the review route. This is an
// operator DTO, not a receipt export: it intentionally excludes source URLs,
// raw responses, request payloads, remote IDs, credentials and token/cost data.
function instagramCarouselDto(result) {
  const review = result?.review || result?.carousel || null;
  if (!review) return null;
  const carousel = review.carousel || review;
  const preparationStatus = safeCarouselState(
    review.preparationState || review.preparation_state || carousel.preparationState || carousel.preparation_state || result?.status,
    CAROUSEL_PREPARATION_STATES,
    'not_prepared'
  );
  const deliveryStatus = safeCarouselState(
    review.deliveryState || review.delivery_state || carousel.deliveryState || carousel.delivery_state || result?.state,
    CAROUSEL_DELIVERY_STATES,
    'not_started'
  );
  const assets = carouselAssetsDto(review.assets || carousel.assets);
  const text = carouselTextDto(review.textParts || review.text_parts || carousel.textParts || carousel.text_parts);
  const effectivePreparationStatus = preparationStatus === 'ready' && (!assets.valid || !text.valid)
    ? 'blocked'
    : preparationStatus;
  return {
    version: typeof (review.version || review.contractVersion || carousel.contract_version) === 'string'
      ? (review.version || review.contractVersion || carousel.contract_version).slice(0, 120)
      : null,
    preparation_status: effectivePreparationStatus,
    delivery_status: deliveryStatus,
    assets_valid: assets.valid,
    assets: assets.assets,
    caption: text.caption,
    comments: text.comments,
    text_valid: text.valid,
    receipt_summary: carouselReceiptSummary(review.receipts || carousel.receipts, review.receiptSummary || carousel.receipt_summary),
    comment_delivery: carouselCommentDeliveryDto(
      review.commentDelivery || review.comment_delivery || carousel.commentDelivery || carousel.comment_delivery,
      review.receipts || carousel.receipts,
      text.comments,
    ),
    comment_order_repair: commentOrderRepairDto(review.commentOrderRepair || review.comment_order_repair || carousel.commentOrderRepair || carousel.comment_order_repair),
  };
}

function commentOrderRepairDto(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = typeof raw.status === 'string' ? raw.status.slice(0, 80) : 'not_eligible';
  const actionSummary = (value) => {
    const source = value && typeof value === 'object' ? value : {};
    const fields = ['total', 'intent', 'accepted', 'unknown', 'reconciled', 'failed', 'ambiguous', 'inconclusive'];
    return Object.fromEntries(fields.map((field) => [field, Number.isSafeInteger(source[field]) && source[field] >= 0 ? source[field] : 0]));
  };
  return {
    legacy_detected: raw.legacyDetected === true || raw.legacy_detected === true,
    status,
    logical_part_count: Number.isSafeInteger(raw.logicalPartCount) ? raw.logicalPartCount
      : (Number.isSafeInteger(raw.logical_part_count) ? raw.logical_part_count : 0),
    legacy_physical_order: typeof (raw.legacyPhysicalOrder || raw.legacy_physical_order) === 'string'
      ? String(raw.legacyPhysicalOrder || raw.legacy_physical_order).slice(0, 80) : null,
    known_reader_order: typeof (raw.knownReaderOrder || raw.known_reader_order) === 'string'
      ? String(raw.knownReaderOrder || raw.known_reader_order).slice(0, 80) : null,
    desired_reader_order: typeof (raw.desiredReaderOrder || raw.desired_reader_order) === 'string'
      ? String(raw.desiredReaderOrder || raw.desired_reader_order).slice(0, 80) : null,
    source_proven: raw.sourceProven === true || raw.source_proven === true,
    original_actions: actionSummary(raw.originalActions || raw.original_actions),
    replacement_actions: actionSummary(raw.replacementActions || raw.replacement_actions),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : null,
  };
}

function instagramRepublicationDto(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const receipt = raw.receiptSummary && typeof raw.receiptSummary === 'object' ? raw.receiptSummary : {};
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    eligible: raw.eligible === true,
    source_contract_version: typeof raw.sourceContractVersion === 'string' ? raw.sourceContractVersion.slice(0, 120) : null,
    source_proven: raw.sourceProven === true,
    asset_count: count(raw.assetCount),
    comment_part_count: count(raw.commentPartCount),
    model_calls: count(raw.modelCalls),
    added_model_cost_usd: Number.isFinite(raw.addedModelCostUsd) && raw.addedModelCostUsd >= 0 ? raw.addedModelCostUsd : null,
    retired_media_state: ['not_checked', 'missing', 'present', 'inconclusive'].includes(raw.retiredMediaState)
      ? raw.retiredMediaState : 'not_checked',
    receipt_summary: {
      total: count(receipt.total), intent: count(receipt.intent), accepted: count(receipt.accepted),
      unknown: count(receipt.unknown), reconciled: count(receipt.reconciled), failed: count(receipt.failed),
      ambiguous: count(receipt.ambiguous), inconclusive: count(receipt.inconclusive),
    },
    error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : null,
  };
}

function carouselActionStatus(result) {
  const status = result?.status || result?.state;
  const state = result?.state || result?.status;
  if (['in_progress', 'preparing', 'publishing', 'awaiting_reconciliation', 'inconclusive', 'partial'].includes(status)
    || ['in_progress', 'preparing', 'publishing', 'awaiting_reconciliation', 'inconclusive'].includes(state)) {
    return 409;
  }
  if (['unavailable', 'not_prepared', 'not_ready', 'not_eligible', 'blocked', 'failed', 'skipped'].includes(status)
    || ['unavailable', 'not_prepared', 'not_ready', 'not_eligible', 'blocked', 'failed', 'skipped'].includes(state)) {
    return 422;
  }
  return 200;
}

function carouselActionDto(digestId, result) {
  return {
    digestId,
    status: typeof result?.status === 'string' ? result.status : 'unknown',
    state: typeof result?.state === 'string' ? result.state : null,
    carousel: instagramCarouselDto(result),
  };
}

// GET /api/digests/:id/instagram-card — the exact review asset prepared during
// digest generation. It never generates a new card or contacts Instagram.
router.get('/:id/instagram-card', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const artifact = getLatestDigestStageArtifact({
      digestId: digest.id,
      stage: INSTAGRAM_CARD_STAGE,
      stageVersion: INSTAGRAM_CARD_STAGE_VERSION,
    });
    if (!artifact) return res.status(404).json({ error: 'Instagram card has not been prepared for this digest' });
    return res.json({ digestId: digest.id, card: instagramCardDto(artifact) });
  } catch (err) {
    console.error('[digests] GET /:id/instagram-card error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/digests/:id/instagram-card/retry — explicit operator retry for a
// failed/stale card receipt. The successful same-input receipt is idempotently
// reused; this route does not publish any social-media content.
router.post('/:id/instagram-card/retry', async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCardService();
    if (!service) {
      return res.status(501).json({ error: 'Instagram card preparation is not installed in this build' });
    }
    const result = await service.ensureDigestInstagramCard(digest, config);
    const artifact = result.artifact || getLatestDigestStageArtifact({
      digestId: digest.id,
      stage: INSTAGRAM_CARD_STAGE,
      stageVersion: INSTAGRAM_CARD_STAGE_VERSION,
    });
    const status = result.status === 'failed' ? 422 : result.status === 'in_progress' ? 409 : 200;
    return res.status(status).json({ digestId: digest.id, status: result.status, card: instagramCardDto(artifact) });
  } catch (err) {
    console.error('[digests] POST /:id/instagram-card/retry error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/digests/:id/instagram-carousel — private operator review only.
// This route is intentionally non-mutating: opening the dashboard modal must
// never prepare or publish anything.
router.get('/:id/instagram-carousel', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) {
      return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    }
    const result = await service.getDigestInstagramCarouselReview(digest.id, config);
    const carousel = instagramCarouselDto(result);
    if (!carousel || result?.status === 'not_prepared') {
      return res.status(404).json({
        digestId: digest.id,
        status: 'not_prepared',
        error: 'Instagram carousel has not been prepared for this digest',
      });
    }
    return res.json({ digestId: digest.id, status: result?.status || 'review', carousel });
  } catch (err) {
    console.error('[digests] GET /:id/instagram-carousel error:', err);
    return res.status(500).json({ error: 'Unable to load Instagram carousel review' });
  }
});

// POST /api/digests/:id/instagram-carousel/prepare — explicit local review
// preparation. The service builds immutable local review material only; it
// never sends an Instagram request.
router.post('/:id/instagram-carousel/prepare', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) {
      return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    }
    const result = await service.prepareDigestInstagramCarousel(digest, config);
    return res.status(carouselActionStatus(result))
      .json(carouselActionDto(digest.id, result));
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/prepare error:', err);
    return res.status(500).json({ error: 'Unable to prepare Instagram carousel review' });
  }
});

// POST /api/digests/:id/instagram-carousel/publish — the only explicit
// delivery action. It is deliberately separate from generic digest publishing:
// updating digests.status='published' neither proves nor triggers this route.
router.post('/:id/instagram-carousel/publish', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) {
      return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    }
    const result = await service.publishDigestInstagramCarousel(digest, config);
    return res.status(carouselActionStatus(result))
      .json(carouselActionDto(digest.id, result));
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/publish error:', err);
    return res.status(500).json({ error: 'Unable to publish Instagram carousel' });
  }
});

// POST /api/digests/:id/instagram-carousel/reconcile — explicit *read-only*
// reconciliation. It may inspect the remote state but must never make a Meta
// write or retry a media_publish call.
router.post('/:id/instagram-carousel/reconcile', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) {
      return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    }
    const result = await service.reconcileDigestInstagramCarousel(digest, config);
    return res.status(carouselActionStatus(result))
      .json(carouselActionDto(digest.id, result));
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/reconcile error:', err);
    return res.status(500).json({ error: 'Unable to reconcile Instagram carousel' });
  }
});

// A replacement is intentionally not a retry of the original v3 media
// receipt. It uses a distinct delivery ledger that references the immutable
// legacy asset/text snapshot only after the owner has manually deleted it.
router.get('/:id/instagram-carousel/republication', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramRepublicationService();
    if (!service) return res.status(501).json({ error: 'Instagram republication is not installed in this build' });
    const result = service.getDigestInstagramCarouselRepublicationReview(digest.id);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
      republication: instagramRepublicationDto(result.republication),
    });
  } catch (err) {
    console.error('[digests] GET /:id/instagram-carousel/republication error:', err);
    return res.status(500).json({ error: 'Unable to load Instagram republication review' });
  }
});

// This local-only step records a new delivery ledger that points at the exact
// v3 frozen assets/text. It never calls Meta and may be done before deletion.
router.post('/:id/instagram-carousel/republication/prepare', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramRepublicationService();
    if (!service) return res.status(501).json({ error: 'Instagram republication is not installed in this build' });
    const result = await service.prepareDigestInstagramCarouselRepublication(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
      republication: instagramRepublicationDto(result.republication),
    });
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/republication/prepare error:', err);
    return res.status(500).json({ error: 'Unable to prepare Instagram republication' });
  }
});

// Read-only proof: a replacement is ready only when Meta returns a definite
// not-found for the original immutable v3 media id. It creates no local row.
router.get('/:id/instagram-carousel/republication/retired-media-preflight', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramRepublicationService();
    if (!service) return res.status(501).json({ error: 'Instagram republication is not installed in this build' });
    const result = await service.preflightDigestInstagramCarouselRepublication(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
      republication: instagramRepublicationDto(result.republication),
    });
  } catch (err) {
    console.error('[digests] GET /:id/instagram-carousel/republication/retired-media-preflight error:', err);
    return res.status(500).json({ error: 'Unable to preflight retired Instagram media' });
  }
});

// This is the sole new-media write after a human deletion. It repeats the
// absence proof immediately before recording its media_publish intent.
router.post('/:id/instagram-carousel/republication/publish', operatorAuth, async (req, res) => {
  try {
    if (req.body?.confirm !== 'REPUBLISH_AFTER_OWNER_DELETE') {
      return res.status(400).json({ error: 'Exact confirmation REPUBLISH_AFTER_OWNER_DELETE is required' });
    }
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramRepublicationService();
    if (!service) return res.status(501).json({ error: 'Instagram republication is not installed in this build' });
    const result = await service.publishDigestInstagramCarouselRepublication(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
      republication: instagramRepublicationDto(result.republication),
    });
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/republication/publish error:', err);
    return res.status(500).json({ error: 'Unable to publish Instagram republication' });
  }
});

// Reconciliation never calls Meta POST; it can only attach read-only proof to
// an existing unknown media/comment/reply intent.
router.post('/:id/instagram-carousel/republication/reconcile', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramRepublicationService();
    if (!service) return res.status(501).json({ error: 'Instagram republication is not installed in this build' });
    const result = await service.reconcileDigestInstagramCarouselRepublication(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
      republication: instagramRepublicationDto(result.republication),
    });
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/republication/reconcile error:', err);
    return res.status(500).json({ error: 'Unable to reconcile Instagram republication' });
  }
});

// GET /api/digests/:id/instagram-carousel/comment-order-repair — a read-only
// preflight for the legacy v3 chronology repair. It reads Meta comments only to
// prove self-authored id/text identity; no ledger row or external write occurs.
router.get('/:id/instagram-carousel/comment-order-repair', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    const result = await service.preflightDigestInstagramCarouselCommentOrderRepair(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: { comment_order_repair: commentOrderRepairDto(result.repair) },
    });
  } catch (err) {
    console.error('[digests] GET /:id/instagram-carousel/comment-order-repair error:', err);
    return res.status(500).json({ error: 'Unable to preflight Instagram comment-order repair' });
  }
});

// POST /api/digests/:id/instagram-carousel/comment-order-repair — explicit,
// confirmed corrective mutation for an existing v3 carousel. It never calls
// media_publish: after a fresh exact preflight it deletes only receipt-proven
// self comments and writes frozen replacements in reverse physical order.
router.post('/:id/instagram-carousel/comment-order-repair', operatorAuth, async (req, res) => {
  try {
    if (req.body?.confirm !== 'REPAIR_COMMENT_ORDER') {
      return res.status(400).json({ error: 'Exact confirmation REPAIR_COMMENT_ORDER is required' });
    }
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    const result = await service.repairDigestInstagramCarouselCommentOrder(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
    });
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/comment-order-repair error:', err);
    return res.status(500).json({ error: 'Unable to repair Instagram comment order' });
  }
});

// POST /api/digests/:id/instagram-carousel/comment-order-repair/reconcile —
// strictly read-only proof for a lost repair delete/replacement response.
router.post('/:id/instagram-carousel/comment-order-repair/reconcile', operatorAuth, async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    const service = await loadDigestInstagramCarouselService();
    if (!service) return res.status(501).json({ error: 'Instagram carousel delivery is not installed in this build' });
    const result = await service.reconcileDigestInstagramCarouselCommentOrderRepair(digest, config);
    return res.status(carouselActionStatus(result)).json({
      digestId: digest.id,
      status: result.status,
      carousel: instagramCarouselDto(result),
    });
  } catch (err) {
    console.error('[digests] POST /:id/instagram-carousel/comment-order-repair/reconcile error:', err);
    return res.status(500).json({ error: 'Unable to reconcile Instagram comment-order repair' });
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

    if (showFull(req)) {
      return res.json({ ...digest, articles });
    }
    res.json({ ...publicDigest(digest), articles: articles.map(publicArticle) });
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

// POST /api/digests/:id/publish — publish to selected platforms
// Body: { platforms: ["telegram", "facebook"] } — optional, defaults to all
router.post('/:id/publish', async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    if (!digest.content) {
      return res.status(400).json({ error: 'Digest has no content to publish' });
    }

    const { platforms } = req.body || {};
    const results = await publishDigest(digest, config, platforms);
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

// PATCH /api/digests/:id/status — update digest status (draft/ready_for_review/published)
router.patch('/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !['draft', 'ready_for_review', 'published'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "draft", "ready_for_review" or "published"' });
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
        `UPDATE digests SET status = ?, published_at = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(status, req.params.id);
    }

    const updated = getDigest(req.params.id);
    res.json({ ok: true, id: req.params.id, status: updated.status, published_at: updated.published_at });
  } catch (err) {
    console.error('[digests] PATCH /:id/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/digests/:id — delete a digest
router.delete('/:id', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const db = getDb();
    const carousel = db.prepare(
      'SELECT id FROM digest_instagram_carousels WHERE digest_id = ? LIMIT 1'
    ).get(req.params.id);
    if (carousel) {
      return res.status(409).json({
        error: 'Digest has immutable Instagram carousel evidence and cannot be deleted',
      });
    }
    if (isDigestReferencedByReviewRun(req.params.id)) {
      return res.status(409).json({
        error: 'Digest is referenced by an immutable review run and cannot be deleted',
      });
    }
    const remove = db.transaction(() => {
      // A review digest has a separate batch record that references it. Delete
      // that local review ledger first; stage receipts intentionally remain
      // immutable and make a later regeneration resumable.
      const batchIds = db.prepare('SELECT id FROM digest_batches WHERE digest_id = ?').all(req.params.id);
      for (const batch of batchIds) {
        db.prepare('DELETE FROM digest_batch_items WHERE batch_id = ?').run(batch.id);
        db.prepare('DELETE FROM digest_batches WHERE id = ?').run(batch.id);
      }
      db.prepare(`UPDATE articles SET digest_id = NULL, status = 'new', commentary = NULL WHERE digest_id = ?`).run(req.params.id);
      db.prepare('DELETE FROM digests WHERE id = ?').run(req.params.id);
    });
    remove.immediate();

    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    console.error('[digests] DELETE /:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
