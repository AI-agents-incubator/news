#!/usr/bin/env node

/**
 * Dedicated internal Substack publisher.
 *
 * Safety properties:
 * - bearer-authenticated HTTP API on an internal-only container port;
 * - exact publication-origin allowlist;
 * - persistent, pre-write idempotency receipts;
 * - an interrupted/in-progress operation becomes uncertain and cannot be
 *   blindly retried;
 * - email delivery is never accepted;
 * - web publication needs an explicit feature flag and a disengaged kill
 *   switch;
 * - no cookie, token, request body, or CDP payload is logged.
 *
 * The driver is calibrated for authenticated draft creation, exact read-back,
 * images, native audio, and native video. Web-only publication is implemented
 * behind a separate disabled-by-default feature flag and always uses
 * `send:false`; Substack email delivery is not implemented.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RECEIPT_VERSION = 1;
const ALLOWED_PUBLICATION_URL = 'https://biggame.substack.com';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_ITEMS = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_MEDIA_BYTES = 200 * 1024 * 1024;
const REMOTE_OPERATION_TIMEOUT_MS = 30_000;
const DRAFT_FIELDS = new Set([
  'attemptId',
  'publicationUrl',
  'title',
  'subtitle',
  'bodyText',
  'media',
  'mode',
]);
const PUBLISH_FIELDS = new Set(['attemptId', 'mode', 'send', 'email']);
const SAFE_RETRY_STATES = new Set([
  'auth_required',
  'calibration_required',
  'failed_prewrite',
]);
const BLOCKED_RETRY_STATES = new Set(['reserved', 'in_progress', 'uncertain']);

export class PublisherError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'PublisherError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new PublisherError(500, 'invalid_configuration', `Invalid boolean value: ${normalized}`);
}

function parsePort(value, fallback, name) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new PublisherError(500, 'invalid_configuration', `${name} must be a valid TCP port.`);
  }
  return parsed;
}

export function normalizePublicationUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublisherError(400, 'invalid_publication_url', 'publicationUrl must be a valid URL.');
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname.endsWith('.substack.com')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new PublisherError(
      400,
      'invalid_publication_url',
      'publicationUrl must be an https://*.substack.com origin.',
    );
  }
  return parsed.origin;
}

function assertPlainObject(value, code = 'invalid_request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublisherError(400, code, 'JSON body must be an object.');
  }
}

function rejectForbiddenDeliveryFlags(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if ((normalized.includes('email') || normalized.includes('send')) && nested === true) {
      throw new PublisherError(
        400,
        'email_delivery_forbidden',
        'Email/send delivery is forbidden by this service.',
      );
    }
    if (nested && typeof nested === 'object') rejectForbiddenDeliveryFlags(nested);
  }
}

function rejectUnknownFields(value, allowed) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new PublisherError(
      400,
      'unknown_fields',
      `Unknown request field(s): ${unknown.join(', ')}`,
    );
  }
}

function validateText(value, field, { required = true, maxLength }) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    throw new PublisherError(400, 'invalid_request', `${field} must be a string.`);
  }
  if (required && value.trim().length === 0) {
    throw new PublisherError(400, 'invalid_request', `${field} must not be empty.`);
  }
  if (value.length > maxLength) {
    throw new PublisherError(
      400,
      'invalid_request',
      `${field} exceeds the ${maxLength}-character limit.`,
    );
  }
  return value;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function validateDraftPayload(payload, options) {
  assertPlainObject(payload);
  rejectForbiddenDeliveryFlags(payload);
  rejectUnknownFields(payload, DRAFT_FIELDS);

  const attemptId = validateText(payload.attemptId, 'attemptId', {
    maxLength: 128,
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) {
    throw new PublisherError(
      400,
      'invalid_attempt_id',
      'attemptId may contain only letters, numbers, dot, underscore, colon, and hyphen.',
    );
  }

  const publicationUrl = normalizePublicationUrl(payload.publicationUrl);
  if (publicationUrl !== options.publicationUrl) {
    throw new PublisherError(
      403,
      'publication_not_allowed',
      'publicationUrl is not the publication configured for this service.',
    );
  }

  const title = validateText(payload.title, 'title', { maxLength: 300 });
  if (options.titlePrefix && !title.startsWith(options.titlePrefix)) {
    throw new PublisherError(
      400,
      'title_prefix_required',
      `title must start with the configured prefix ${options.titlePrefix}.`,
    );
  }
  const subtitle = validateText(payload.subtitle, 'subtitle', {
    required: false,
    maxLength: 500,
  });
  const bodyText = validateText(payload.bodyText, 'bodyText', {
    maxLength: 1_500_000,
  });

  if (!Array.isArray(payload.media) || payload.media.length > MAX_MEDIA_ITEMS) {
    throw new PublisherError(
      400,
      'invalid_media',
      `media must be an array with at most ${MAX_MEDIA_ITEMS} items.`,
    );
  }

  const media = payload.media.map((item, index) => {
    assertPlainObject(item, 'invalid_media');
    const allowed = new Set(['path', 'mime', 'kind', 'alt']);
    const unknown = Object.keys(item).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      throw new PublisherError(
        400,
        'invalid_media',
        `media[${index}] contains unknown field(s): ${unknown.join(', ')}`,
      );
    }
    const mediaPath = validateText(item.path, `media[${index}].path`, {
      maxLength: 4096,
    });
    const resolvedPath = path.resolve(mediaPath);
    if (!path.isAbsolute(mediaPath) || !pathIsInside(options.mediaRoot, resolvedPath)) {
      throw new PublisherError(
        400,
        'invalid_media_path',
        `media[${index}].path must be inside the configured media root.`,
      );
    }
    const mime = validateText(item.mime, `media[${index}].mime`, { maxLength: 127 });
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime)) {
      throw new PublisherError(400, 'invalid_media', `media[${index}].mime is invalid.`);
    }
    const kind = validateText(item.kind, `media[${index}].kind`, { maxLength: 32 });
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(kind)) {
      throw new PublisherError(400, 'invalid_media', `media[${index}].kind is invalid.`);
    }
    const alt = validateText(item.alt, `media[${index}].alt`, {
      required: false,
      maxLength: 1000,
    });
    return {
      path: resolvedPath,
      mime,
      kind,
      ...(alt === undefined ? {} : { alt }),
    };
  });

  if (payload.mode !== 'draft_only' && payload.mode !== 'web_only') {
    throw new PublisherError(
      400,
      'invalid_mode',
      'mode must be exactly draft_only or web_only.',
    );
  }

  return {
    attemptId,
    publicationUrl,
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    bodyText,
    media,
    mode: payload.mode,
  };
}

export async function assertMediaFiles(media, mediaRoot) {
  const canonicalRoot = await realpath(mediaRoot);
  for (const [index, item] of media.entries()) {
    let metadata;
    let canonicalPath;
    try {
      metadata = await stat(item.path);
      await access(item.path);
      canonicalPath = await realpath(item.path);
    } catch {
      throw new PublisherError(
        400,
        'media_not_found',
        `media[${index}].path does not reference a readable file.`,
      );
    }
    if (!metadata.isFile()) {
      throw new PublisherError(
        400,
        'invalid_media_path',
        `media[${index}].path must reference a regular file.`,
      );
    }
    const limit = item.kind === 'image' ? MAX_IMAGE_BYTES : MAX_NATIVE_MEDIA_BYTES;
    if (metadata.size < 1 || metadata.size > limit) {
      throw new PublisherError(
        400,
        'invalid_media_size',
        `media[${index}] must be between 1 and ${limit} bytes.`,
      );
    }
    if (!pathIsInside(canonicalRoot, canonicalPath)) {
      throw new PublisherError(
        400,
        'invalid_media_path',
        `media[${index}].path resolves outside the configured media root.`,
      );
    }
  }
}

export function validatePublishPayload(payload = {}) {
  assertPlainObject(payload);
  rejectForbiddenDeliveryFlags(payload);
  rejectUnknownFields(payload, PUBLISH_FIELDS);
  for (const field of ['send', 'email']) {
    if (field in payload && payload[field] !== false) {
      throw new PublisherError(
        400,
        'email_delivery_forbidden',
        `${field} may only be omitted or set to false.`,
      );
    }
  }
  if (payload.mode !== undefined && payload.mode !== 'web_only') {
    throw new PublisherError(
      400,
      'web_only_required',
      'The publish endpoint accepts only mode=web_only.',
    );
  }
  let attemptId;
  if (payload.attemptId !== undefined) {
    attemptId = validateText(payload.attemptId, 'attemptId', { maxLength: 128 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) {
      throw new PublisherError(
        400,
        'invalid_attempt_id',
        'attemptId may contain only letters, numbers, dot, underscore, colon, and hyphen.',
      );
    }
  }
  return {
    ...(attemptId === undefined ? {} : { attemptId }),
    mode: 'web_only',
    send: false,
    email: false,
  };
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receiptIdForAttempt(attemptId) {
  return sha256(`substack-draft:${attemptId}`);
}

function nowIso() {
  return new Date().toISOString();
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Receipt file fsync is the primary durability boundary. Some filesystems
    // do not permit fsync on directories, so this remains best-effort.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeDurableNew(target, contents) {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(target));
}

function draftSummary(draft) {
  return {
    publicationUrl: draft.publicationUrl,
    title: draft.title,
    subtitlePresent: draft.subtitle !== undefined,
    bodySha256: sha256(draft.bodyText),
    bodyLength: draft.bodyText.length,
    media: draft.media.map(item => ({
      path: item.path,
      mime: item.mime,
      kind: item.kind,
      altPresent: item.alt !== undefined,
    })),
    mode: draft.mode,
  };
}

function draftPayloadHash(draft) {
  return sha256(JSON.stringify(draft));
}

export class ReceiptStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  fileForId(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new PublisherError(400, 'invalid_draft_id', 'Draft id is invalid.');
    }
    return path.join(this.root, `${id}.json`);
  }

  async read(id) {
    let contents;
    try {
      contents = await readFile(this.fileForId(id), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    return JSON.parse(contents);
  }

  async writeAtomic(receipt) {
    const target = this.fileForId(receipt.id);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    await writeDurableNew(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(temporary, target);
    await syncDirectory(this.root);
    return receipt;
  }

  async reserveDraft(draft) {
    const id = receiptIdForAttempt(draft.attemptId);
    const payloadHash = draftPayloadHash(draft);
    const timestamp = nowIso();
    const receipt = {
      version: RECEIPT_VERSION,
      id,
      draftId: id,
      draftAttemptId: draft.attemptId,
      attemptId: draft.attemptId,
      state: 'reserved',
      publicationUrl: draft.publicationUrl,
      mode: draft.mode,
      send: false,
      payloadHash,
      request: draft,
      requestSummary: draftSummary(draft),
      draft: {
        state: 'reserved',
        safeToRetry: false,
        attempts: 0,
        reservedAt: timestamp,
        updatedAt: timestamp,
      },
      publish: {
        state: 'not_requested',
        safeToRetry: true,
        attempts: 0,
        updatedAt: timestamp,
      },
    };
    try {
      await writeDurableNew(
        this.fileForId(id),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      return { receipt, created: true, replay: false };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    const existing = await this.read(id);
    if (!existing || existing.payloadHash !== payloadHash) {
      throw new PublisherError(
        409,
        'attempt_id_conflict',
        'attemptId already exists with a different payload.',
      );
    }
    if (BLOCKED_RETRY_STATES.has(existing.draft.state)) {
      throw new PublisherError(
        409,
        'uncertain_outcome',
        'The prior attempt is in progress or uncertain; blind retry is blocked.',
        { id, state: existing.draft.state },
      );
    }
    if (existing.draft.state === 'succeeded') {
      return { receipt: existing, created: false, replay: true };
    }
    if (!SAFE_RETRY_STATES.has(existing.draft.state)) {
      throw new PublisherError(
        409,
        'draft_not_retryable',
        `Draft is not retryable from state ${existing.draft.state}.`,
      );
    }
    return { receipt: existing, created: false, replay: false };
  }

  async markDraft(id, state, patch = {}) {
    const receipt = await this.read(id);
    if (!receipt) throw new PublisherError(404, 'draft_not_found', 'Draft receipt not found.');
    receipt.draft = {
      ...receipt.draft,
      ...patch,
      state,
      safeToRetry: SAFE_RETRY_STATES.has(state),
      updatedAt: nowIso(),
    };
    receipt.state = state === 'succeeded' ? 'draft' : state;
    if (state === 'succeeded' && patch.postId) receipt.postId = patch.postId;
    return this.writeAtomic(receipt);
  }

  async beginDraft(id) {
    const receipt = await this.read(id);
    if (!receipt) throw new PublisherError(404, 'draft_not_found', 'Draft receipt not found.');
    receipt.draft = {
      ...receipt.draft,
      state: 'in_progress',
      safeToRetry: false,
      attempts: (receipt.draft.attempts || 0) + 1,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    receipt.state = 'in_progress';
    return this.writeAtomic(receipt);
  }

  async beginPublish(id, publishRequest) {
    const receipt = await this.read(id);
    if (!receipt) throw new PublisherError(404, 'draft_not_found', 'Draft receipt not found.');
    if (receipt.draft.state !== 'succeeded') {
      throw new PublisherError(
        409,
        'draft_not_ready',
        `Draft must be succeeded before web publish (current: ${receipt.draft.state}).`,
      );
    }
    if (
      receipt.publish.attemptId
      && receipt.publish.attemptId !== publishRequest.attemptId
    ) {
      throw new PublisherError(
        409,
        'attempt_id_conflict',
        'This draft already has a different web-publish attemptId.',
      );
    }
    if (BLOCKED_RETRY_STATES.has(receipt.publish.state)) {
      throw new PublisherError(
        409,
        'uncertain_outcome',
        'The prior web publish is in progress or uncertain; blind retry is blocked.',
        { id, state: receipt.publish.state },
      );
    }
    if (receipt.publish.state === 'succeeded') {
      return { receipt, replay: true };
    }
    receipt.publish = {
      ...receipt.publish,
      state: 'in_progress',
      safeToRetry: false,
      attemptId: publishRequest.attemptId,
      payloadHash: sha256(JSON.stringify(publishRequest)),
      attempts: (receipt.publish.attempts || 0) + 1,
      startedAt: nowIso(),
      updatedAt: nowIso(),
    };
    receipt.attemptId = publishRequest.attemptId;
    receipt.mode = 'web_only';
    receipt.send = false;
    receipt.state = 'publishing';
    return { receipt: await this.writeAtomic(receipt), replay: false };
  }

  async markPublish(id, state, patch = {}) {
    const receipt = await this.read(id);
    if (!receipt) throw new PublisherError(404, 'draft_not_found', 'Draft receipt not found.');
    receipt.publish = {
      ...receipt.publish,
      ...patch,
      state,
      safeToRetry: SAFE_RETRY_STATES.has(state),
      updatedAt: nowIso(),
    };
    receipt.state = state === 'succeeded' ? 'published' : state;
    if (state === 'succeeded') {
      receipt.send = false;
      if (patch.postId) receipt.postId = patch.postId;
      if (patch.permalink) receipt.permalink = patch.permalink;
    }
    return this.writeAtomic(receipt);
  }
}

export class MutationQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

export function cdpConnect(wsUrl, WebSocketImpl = globalThis.WebSocket) {
  if (!WebSocketImpl) {
    return Promise.reject(new Error('Global WebSocket is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let sequence = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error('CDP connection timeout.'));
      try {
        ws.close();
      } catch {
        // no-op
      }
    }, 8000);

    const failPending = (message) => {
      for (const item of pending.values()) item.reject(new Error(message));
      pending.clear();
    };

    ws.onopen = () => {
      settled = true;
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          return new Promise((resolveSend, rejectSend) => {
            const id = ++sequence;
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, listener) {
          if (typeof listener !== 'function') {
            throw new TypeError('CDP event listener must be a function.');
          }
          const methodListeners = listeners.get(method) || new Set();
          methodListeners.add(listener);
          listeners.set(method, methodListeners);
          return () => methodListeners.delete(listener);
        },
        close() {
          try {
            ws.close();
          } catch {
            // no-op
          }
        },
      });
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      if (!settled) reject(new Error('CDP websocket error.'));
      failPending('CDP websocket error.');
    };
    ws.onclose = () => failPending('CDP websocket closed.');
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id && message.method) {
        for (const listener of listeners.get(message.method) || []) {
          try {
            listener(message.params || {});
          } catch {
            // Event observers are diagnostic; they must not break CDP replies.
          }
        }
        return;
      }
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) {
        callback.reject(new Error(`CDP ${message.error.code || 'error'}: ${message.error.message}`));
      } else {
        callback.resolve(message.result);
      }
    };
  });
}

function evaluateValue(result) {
  if (result?.exceptionDetails) throw new Error('Page-context evaluation failed.');
  return result?.result?.value;
}

export async function pageContextRequest(cdp, pageUrl, requestUrl, options = {}) {
  const pageOrigin = new URL(pageUrl).origin;
  const target = new URL(requestUrl, pageOrigin);
  if (target.origin !== pageOrigin || target.username || target.password) {
    throw new PublisherError(
      400,
      'cross_origin_request_blocked',
      'Page-context requests must remain on the authenticated page origin.',
    );
  }
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new PublisherError(400, 'invalid_request_method', 'Unsupported page request method.');
  }
  const headers = options.headers || {};
  assertPlainObject(headers);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'cookie' || key.toLowerCase() === 'authorization') {
      throw new PublisherError(
        400,
        'sensitive_header_blocked',
        'Cookie and Authorization headers may not be injected.',
      );
    }
  }
  const input = {
    url: target.href,
    method,
    headers,
    body: options.body ?? null,
    timeoutMs: Math.min(Math.max(options.timeoutMs || 15000, 1000), 30000),
  };
  const expression = `
    (async () => {
      const input = ${JSON.stringify(input)};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          credentials: 'include',
          redirect: 'error',
          signal: controller.signal
        });
        const text = (await response.text()).slice(0, 1048576);
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
          etag: response.headers.get('etag'),
          text
        };
      } finally {
        clearTimeout(timer);
      }
    })()
  `;
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return evaluateValue(evaluated);
}

export async function pageContextPresignedPut(cdp, uploadUrl, bytes) {
  let target;
  try {
    target = new URL(uploadUrl);
  } catch {
    throw new PublisherError(
      502,
      'invalid_substack_upload_url',
      'Substack returned an invalid presigned upload URL.',
    );
  }
  if (
    target.protocol !== 'https:'
    || target.hostname !== 'substack-video.s3-accelerate.amazonaws.com'
    || !target.pathname.startsWith('/video_upload/')
    || !target.searchParams.has('X-Amz-Signature')
  ) {
    throw new PublisherError(
      502,
      'invalid_substack_upload_url',
      'Substack returned a presigned URL outside the upload allowlist.',
    );
  }
  const input = {
    url: target.href,
    data: Buffer.from(bytes).toString('base64'),
  };
  const expression = `
    (async () => {
      const input = ${JSON.stringify(input)};
      const raw = atob(input.data);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) {
        bytes[index] = raw.charCodeAt(index);
      }
      const response = await fetch(input.url, {
        method: 'PUT',
        body: bytes,
        credentials: 'omit',
        redirect: 'error'
      });
      return {
        ok: response.ok,
        status: response.status,
        etag: response.headers.get('etag')
      };
    })()
  `;
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = evaluateValue(evaluated);
  if (!result?.ok || typeof result.etag !== 'string' || result.etag.length === 0) {
    throw new PublisherError(
      502,
      'substack_media_part_upload_failed',
      `Substack media part upload failed with HTTP ${result?.status || 0}.`,
    );
  }
  return result.etag;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function proseMirrorTextDocument(bodyText, mediaNodes = []) {
  const paragraphs = bodyText.split(/\n{2,}/).map((text) => {
    const node = {
      type: 'paragraph',
      attrs: { textAlign: null },
    };
    if (text.length > 0) node.content = [{ type: 'text', text }];
    return node;
  });
  const content = paragraphs.length > 0
    ? paragraphs
    : [{ type: 'paragraph', attrs: { textAlign: null } }];
  for (const media of mediaNodes) {
    if (media.kind === 'image') {
      content.push({
        type: 'image2',
        attrs: {
          src: media.url,
          height: null,
          width: null,
          bytes: media.bytes,
          alt: media.alt || '',
          title: null,
          type: null,
          href: null,
        },
      });
    } else if (media.kind === 'audio') {
      content.push({
        type: 'audio',
        attrs: {
          label: null,
          mediaUploadId: media.mediaUploadId,
          duration: media.duration ?? null,
          downloadable: false,
          isEditorNode: true,
        },
      });
    } else if (media.kind === 'video') {
      content.push({
        type: 'video',
        attrs: {
          mediaUploadId: media.mediaUploadId,
          duration: media.duration ?? null,
        },
      });
    }
    content.push({ type: 'paragraph', attrs: { textAlign: null } });
  }
  return { type: 'doc', content };
}

function proseMirrorPlainText(node) {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  const values = node.content.map(proseMirrorPlainText).filter(value => value !== '');
  if (node.type === 'doc') return values.join('\n\n');
  return values.join('');
}

function collectImageUrls(node, urls = []) {
  if (!node || typeof node !== 'object') return urls;
  if (node.type === 'image2' && typeof node.attrs?.src === 'string') {
    urls.push(node.attrs.src);
  }
  for (const child of node.content || []) collectImageUrls(child, urls);
  return urls;
}

function collectNativeMediaIds(node, ids = { audio: [], video: [] }) {
  if (!node || typeof node !== 'object') return ids;
  if (
    (node.type === 'audio' || node.type === 'video')
    && typeof node.attrs?.mediaUploadId === 'string'
  ) {
    ids[node.type].push(node.attrs.mediaUploadId);
  }
  for (const child of node.content || []) collectNativeMediaIds(child, ids);
  return ids;
}

function parseJsonResponse(response, operation) {
  let value;
  try {
    value = JSON.parse(response.text);
  } catch {
    throw new PublisherError(
      502,
      'invalid_substack_response',
      `Substack returned invalid JSON during ${operation}.`,
    );
  }
  return value;
}

async function waitFor(condition, timeoutMs = REMOTE_OPERATION_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await condition();
    if (value) return value;
    await delay(200);
  }
  return null;
}

export class ChromeBridge {
  constructor({ port, publicationUrl, fetchImpl = globalThis.fetch }) {
    this.port = port;
    this.publicationUrl = publicationUrl;
    this.fetch = fetchImpl;
  }

  async request(route, options = {}) {
    const response = await this.fetch(`http://127.0.0.1:${this.port}${route}`, {
      ...options,
      signal: AbortSignal.timeout(options.timeoutMs || 3000),
    });
    if (!response.ok) throw new Error(`Chrome CDP HTTP ${response.status}.`);
    return response.json();
  }

  async alive() {
    try {
      await this.request('/json/version', { timeoutMs: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  async publicationTarget() {
    const targets = await this.request('/json/list');
    return targets.find((target) => {
      if (target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
      try {
        return new URL(target.url).origin === this.publicationUrl;
      } catch {
        return false;
      }
    }) || null;
  }

  async inspectAuth() {
    if (!(await this.alive())) {
      return { state: 'chrome_unreachable', authenticated: false };
    }
    const target = await this.publicationTarget();
    if (!target) {
      return {
        state: 'auth_required',
        authenticated: false,
        reason: 'open_publication_in_novnc',
      };
    }
    const cdp = await cdpConnect(target.webSocketDebuggerUrl);
    try {
      await cdp.send('Runtime.enable');
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const pathname = location.pathname;
          const signInForm = Boolean(
            document.querySelector('input[type="password"], form[action*="sign-in"]')
          );
          const publishUi = Boolean(
            document.querySelector('a[href*="/publish"], nav, [role="navigation"]')
          );
          const editorUi = /^\\/publish\\/post\\/\\d+$/.test(pathname)
            && Boolean(
              document.querySelector(
                '.ProseMirror, textarea[aria-label="title"], [data-testid="publish-button"]'
              )
            );
          return {
            origin: location.origin,
            pathname,
            signInForm,
            publishUi,
            editorUi
          };
        })()`,
        returnByValue: true,
      });
      const probe = evaluateValue(evaluated) || {};
      const authenticated = probe.origin === this.publicationUrl
        && String(probe.pathname || '').startsWith('/publish')
        && !probe.signInForm
        && (probe.publishUi || probe.editorUi);
      return authenticated
        ? { state: 'authenticated', authenticated: true }
        : {
          state: 'auth_required',
          authenticated: false,
          reason: 'complete_login_in_novnc',
        };
    } finally {
      cdp.close();
    }
  }
}

export class SubstackDriver {
  constructor({
    chrome,
    killSwitch,
    connect = cdpConnect,
    readFileImpl = readFile,
  }) {
    this.chrome = chrome;
    this.killSwitch = killSwitch;
    this.connect = connect;
    this.readFile = readFileImpl;
  }

  async createEmptyRemoteDraft(cdp) {
    let createRequest = null;
    let createStatus = null;
    const stopRequestObserver = cdp.on('Network.requestWillBeSent', (event) => {
      let requestUrl;
      try {
        requestUrl = new URL(event.request?.url);
      } catch {
        return;
      }
      if (
        event.request?.method === 'POST'
        && requestUrl.origin === this.chrome.publicationUrl
        && requestUrl.pathname === '/api/v1/drafts'
      ) {
        createRequest = {
          requestId: event.requestId,
          postData: event.request.postData || '',
        };
      }
    });
    const stopResponseObserver = cdp.on('Network.responseReceived', (event) => {
      if (createRequest && event.requestId === createRequest.requestId) {
        createStatus = event.response?.status ?? null;
      }
    });

    try {
      await cdp.send('Network.enable');
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', {
        url: `${this.chrome.publicationUrl}/publish/post?type=newsletter`,
      });
      const observed = await waitFor(
        () => createRequest && createStatus !== null,
      );
      if (!observed || createStatus < 200 || createStatus >= 300) {
        throw new PublisherError(
          502,
          'substack_create_failed',
          'Substack did not confirm creation of the empty draft.',
        );
      }
      const editorUrl = await waitFor(async () => {
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        const currentUrl = evaluateValue(evaluated);
        return /^https:\/\/biggame\.substack\.com\/publish\/post\/\d+$/.test(currentUrl)
          ? currentUrl
          : null;
      });
      if (!editorUrl) {
        throw new PublisherError(
          502,
          'substack_create_unverified',
          'Substack created a draft but the editor id could not be verified.',
        );
      }
      const remoteDraftId = new URL(editorUrl).pathname.split('/').pop();
      return { remoteDraftId, editorUrl };
    } finally {
      stopRequestObserver();
      stopResponseObserver();
    }
  }

  async uploadImage(cdp, pageUrl, item, remoteDraftId) {
    const bytes = await this.readFile(item.path);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new PublisherError(
        400,
        'image_too_large',
        `Image exceeds the ${MAX_IMAGE_BYTES}-byte publisher limit.`,
      );
    }
    const response = await pageContextRequest(
      cdp,
      pageUrl,
      '/api/v1/image',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: `data:${item.mime};base64,${bytes.toString('base64')}`,
          postId: Number(remoteDraftId),
        }),
        timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
      },
    );
    if (!response.ok) {
      throw new PublisherError(
        502,
        'substack_image_upload_failed',
        `Substack image upload failed with HTTP ${response.status}.`,
      );
    }
    const uploaded = parseJsonResponse(response, 'image upload');
    let imageUrl;
    try {
      imageUrl = new URL(uploaded.url);
    } catch {
      throw new PublisherError(
        502,
        'invalid_substack_response',
        'Substack image upload did not return a valid URL.',
      );
    }
    if (imageUrl.protocol !== 'https:') {
      throw new PublisherError(
        502,
        'invalid_substack_response',
        'Substack image upload returned a non-HTTPS URL.',
      );
    }
    return {
      kind: 'image',
      url: imageUrl.href,
      bytes: bytes.length,
      alt: item.alt || '',
    };
  }

  async uploadNativeMedia(cdp, pageUrl, item, remoteDraftId) {
    const bytes = await this.readFile(item.path);
    if (bytes.length > MAX_NATIVE_MEDIA_BYTES) {
      throw new PublisherError(
        400,
        'media_too_large',
        `Audio/video exceeds the ${MAX_NATIVE_MEDIA_BYTES}-byte publisher limit.`,
      );
    }
    const query = new URLSearchParams({
      filetype: item.mime,
      fileSize: String(bytes.length),
      fileName: path.basename(item.path),
      post_id: String(remoteDraftId),
    });
    const initiation = await pageContextRequest(
      cdp,
      pageUrl,
      `/api/v1/${item.kind}/upload?${query}`,
      {
        method: 'POST',
        timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
      },
    );
    if (!initiation.ok) {
      throw new PublisherError(
        502,
        'substack_media_upload_failed',
        `Substack ${item.kind} initiation failed with HTTP ${initiation.status}.`,
      );
    }
    const upload = parseJsonResponse(initiation, `${item.kind} initiation`);
    const mediaUploadId = upload.mediaUpload?.id;
    const multipartUploadId = upload.multipartUploadId;
    const urls = upload.multipartUploadUrls;
    if (
      typeof mediaUploadId !== 'string'
      || mediaUploadId.length === 0
      || typeof multipartUploadId !== 'string'
      || multipartUploadId.length === 0
      || !Array.isArray(urls)
      || urls.length === 0
      || !urls.every(url => typeof url === 'string')
    ) {
      throw new PublisherError(
        502,
        'invalid_substack_response',
        `Substack ${item.kind} initiation response is incomplete.`,
      );
    }

    const etags = [];
    const partSize = Math.ceil(bytes.length / urls.length);
    for (let index = 0; index < urls.length; index += 1) {
      const part = bytes.subarray(
        index * partSize,
        Math.min(bytes.length, (index + 1) * partSize),
      );
      etags.push(await pageContextPresignedPut(cdp, urls[index], part));
    }
    const transcode = await pageContextRequest(
      cdp,
      pageUrl,
      `/api/v1/${item.kind}/upload/${encodeURIComponent(mediaUploadId)}/transcode`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          duration: null,
          multipart_upload_id: multipartUploadId,
          multipart_upload_etags: etags,
        }),
        timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
      },
    );
    if (!transcode.ok) {
      throw new PublisherError(
        502,
        'substack_media_transcode_failed',
        `Substack ${item.kind} transcode failed with HTTP ${transcode.status}.`,
      );
    }
    return {
      kind: item.kind,
      mediaUploadId,
      duration: null,
    };
  }

  async updateAndVerifyDraft(cdp, pageUrl, draft, remote) {
    const draftUrl = `/api/v1/drafts/${remote.remoteDraftId}`;
    const initialResponse = await pageContextRequest(cdp, pageUrl, draftUrl);
    if (!initialResponse.ok) {
      throw new PublisherError(
        502,
        'substack_draft_read_failed',
        `Substack draft read failed with HTTP ${initialResponse.status}.`,
        remote,
      );
    }
    const initial = parseJsonResponse(initialResponse, 'draft read');
    const uploadedMedia = [];
    for (const item of draft.media) {
      if (item.kind === 'image') {
        uploadedMedia.push(
          await this.uploadImage(cdp, pageUrl, item, remote.remoteDraftId),
        );
      } else {
        uploadedMedia.push(
          await this.uploadNativeMedia(cdp, pageUrl, item, remote.remoteDraftId),
        );
      }
    }

    const document = proseMirrorTextDocument(draft.bodyText, uploadedMedia);
    const updatePayload = {
      draft_title: draft.title,
      draft_subtitle: draft.subtitle || '',
      draft_podcast_url: null,
      draft_podcast_duration: null,
      draft_body: JSON.stringify(document),
      section_chosen: Boolean(initial.section_chosen),
      draft_section_id: initial.draft_section_id ?? null,
      detect_language: true,
      translations: [],
      draft_bylines: (initial.postBylines || []).map(byline => ({
        id: byline.user_id,
        is_guest: Boolean(byline.is_guest),
      })),
      last_updated_at: initial.draft_updated_at,
    };
    if (
      updatePayload.draft_bylines.length === 0
      || !updatePayload.draft_bylines.every(byline => Number.isInteger(byline.id))
    ) {
      throw new PublisherError(
        502,
        'substack_byline_unavailable',
        'Substack did not return a valid draft byline.',
        remote,
      );
    }

    const updateResponse = await pageContextRequest(cdp, pageUrl, draftUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updatePayload),
      timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
    });
    if (!updateResponse.ok) {
      throw new PublisherError(
        502,
        'substack_draft_update_failed',
        `Substack draft update failed with HTTP ${updateResponse.status}.`,
        remote,
      );
    }

    const verifiedResponse = await pageContextRequest(cdp, pageUrl, draftUrl);
    if (!verifiedResponse.ok) {
      throw new PublisherError(
        502,
        'substack_draft_read_failed',
        `Substack draft verification failed with HTTP ${verifiedResponse.status}.`,
        remote,
      );
    }
    const verified = parseJsonResponse(verifiedResponse, 'draft verification');
    let verifiedDocument;
    try {
      verifiedDocument = JSON.parse(verified.draft_body);
    } catch {
      throw new PublisherError(
        502,
        'invalid_substack_response',
        'Substack draft body could not be verified.',
        remote,
      );
    }
    const expectedImageUrls = uploadedMedia
      .filter(item => item.kind === 'image')
      .map(item => item.url);
    const actualImageUrls = collectImageUrls(verifiedDocument);
    const expectedNativeMedia = {
      audio: uploadedMedia
        .filter(item => item.kind === 'audio')
        .map(item => item.mediaUploadId),
      video: uploadedMedia
        .filter(item => item.kind === 'video')
        .map(item => item.mediaUploadId),
    };
    const actualNativeMedia = collectNativeMediaIds(verifiedDocument);
    const exact = String(verified.id) === String(remote.remoteDraftId)
      && verified.draft_title === draft.title
      && (verified.draft_subtitle || '') === (draft.subtitle || '')
      && proseMirrorPlainText(verifiedDocument) === draft.bodyText
      && JSON.stringify(actualImageUrls) === JSON.stringify(expectedImageUrls)
      && JSON.stringify(actualNativeMedia) === JSON.stringify(expectedNativeMedia)
      && verified.is_published === false;
    if (!exact) {
      throw new PublisherError(
        409,
        'substack_draft_verification_failed',
        'Substack read-back did not exactly match the requested draft.',
        remote,
      );
    }
    return {
      state: 'succeeded',
      remoteDraftId: String(remote.remoteDraftId),
      postId: String(remote.remoteDraftId),
      editorUrl: remote.editorUrl,
      uploadedMedia: uploadedMedia.length,
    };
  }

  async createDraft(draft) {
    if (await this.killSwitch()) {
      throw new PublisherError(423, 'kill_switch_engaged', 'Publisher kill switch is engaged.');
    }
    const auth = await this.chrome.inspectAuth();
    if (!auth.authenticated) return { state: 'auth_required', reason: auth.reason || auth.state };
    const invalidMedia = draft.media.find(
      item => !['image', 'audio', 'video'].includes(item.kind)
        || !item.mime.startsWith(`${item.kind}/`),
    );
    if (invalidMedia) {
      throw new PublisherError(
        400,
        'unsupported_media',
        'Substack media kind and MIME type must match image, audio, or video.',
      );
    }

    const target = await this.chrome.publicationTarget();
    if (!target) return { state: 'auth_required', reason: 'open_publication_in_novnc' };
    const cdp = await this.connect(target.webSocketDebuggerUrl);
    let remote = null;
    try {
      remote = await this.createEmptyRemoteDraft(cdp);
      return await this.updateAndVerifyDraft(cdp, target.url, draft, remote);
    } catch (error) {
      if (remote && error && typeof error === 'object' && !error.details) {
        error.details = remote;
      }
      throw error;
    } finally {
      cdp.close();
    }
  }

  async publishWeb(receipt) {
    if (await this.killSwitch()) {
      throw new PublisherError(423, 'kill_switch_engaged', 'Publisher kill switch is engaged.');
    }
    const auth = await this.chrome.inspectAuth();
    if (!auth.authenticated) return { state: 'auth_required', reason: auth.reason || auth.state };
    const remoteDraftId = receipt.draft?.remoteDraftId;
    if (!/^\d+$/.test(String(remoteDraftId || ''))) {
      throw new PublisherError(
        409,
        'remote_draft_id_missing',
        'The verified Substack draft id is missing.',
      );
    }
    const target = await this.chrome.publicationTarget();
    if (!target) return { state: 'auth_required', reason: 'open_publication_in_novnc' };
    const cdp = await this.connect(target.webSocketDebuggerUrl);
    try {
      await cdp.send('Runtime.enable');
      const draftPath = `/api/v1/drafts/${remoteDraftId}`;
      const beforeResponse = await pageContextRequest(cdp, target.url, draftPath);
      if (!beforeResponse.ok) {
        throw new PublisherError(
          502,
          'substack_draft_read_failed',
          `Substack prepublish draft read failed with HTTP ${beforeResponse.status}.`,
        );
      }
      const before = parseJsonResponse(beforeResponse, 'prepublish draft read');
      if (
        String(before.id) !== String(remoteDraftId)
        || before.draft_title !== receipt.request.title
        || before.is_published !== false
      ) {
        throw new PublisherError(
          409,
          'substack_prepublish_verification_failed',
          'The remote draft no longer matches the verified local receipt.',
        );
      }

      const publishResponse = await pageContextRequest(
        cdp,
        target.url,
        `/api/v1/drafts/${remoteDraftId}/publish`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ send: false }),
          timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
        },
      );
      if (!publishResponse.ok) {
        throw new PublisherError(
          502,
          'substack_web_publish_failed',
          `Substack web-only publish failed with HTTP ${publishResponse.status}.`,
          { remoteDraftId },
        );
      }

      const verifiedResponse = await pageContextRequest(cdp, target.url, draftPath);
      if (!verifiedResponse.ok) {
        throw new PublisherError(
          502,
          'substack_publication_read_failed',
          `Substack publication read-back failed with HTTP ${verifiedResponse.status}.`,
          { remoteDraftId },
        );
      }
      const verified = parseJsonResponse(verifiedResponse, 'publication verification');
      if (
        String(verified.id) !== String(remoteDraftId)
        || verified.is_published !== true
        || verified.email_sent_at
        || typeof verified.slug !== 'string'
        || verified.slug.length === 0
      ) {
        throw new PublisherError(
          409,
          'substack_publication_verification_failed',
          'Substack web publication could not be verified as send=false.',
          { remoteDraftId },
        );
      }
      return {
        state: 'succeeded',
        postId: String(verified.id),
        permalink: `${this.chrome.publicationUrl}/p/${encodeURIComponent(verified.slug)}`,
        send: false,
      };
    } finally {
      cdp.close();
    }
  }
}

export function bearerAuthorized(header, expectedToken) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new PublisherError(413, 'request_too_large', 'JSON request body is too large.');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PublisherError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function publicReceipt(receipt) {
  const base = {
    draftId: receipt.draftId || receipt.id,
    attemptId: receipt.attemptId,
    state: receipt.state
      || (receipt.publish?.state === 'succeeded' ? 'published' : receipt.draft?.state),
    publicationUrl: receipt.publicationUrl || receipt.request.publicationUrl,
    mode: receipt.mode || receipt.request.mode,
  };
  if (base.state === 'published') {
    return {
      ...base,
      send: false,
      ...(receipt.postId === undefined ? {} : { postId: receipt.postId }),
      ...(receipt.permalink === undefined ? {} : { permalink: receipt.permalink }),
    };
  }
  if (base.state === 'draft') {
    return {
      ...base,
      ...(receipt.draft?.remoteDraftId === undefined
        ? {}
        : { remoteDraftId: receipt.draft.remoteDraftId }),
      ...(receipt.draft?.editorUrl === undefined
        ? {}
        : { editorUrl: receipt.draft.editorUrl }),
      title: receipt.request.title,
      ...(receipt.request.subtitle === undefined
        ? {}
        : { subtitle: receipt.request.subtitle }),
      bodyText: receipt.request.bodyText,
      media: receipt.request.media,
    };
  }
  return {
    ...base,
    ...(receipt.draft?.remoteDraftId === undefined
      ? {}
      : { remoteDraftId: receipt.draft.remoteDraftId }),
    ...(receipt.draft?.editorUrl === undefined
      ? {}
      : { editorUrl: receipt.draft.editorUrl }),
    ...(receipt.draft?.reason === undefined ? {} : { reason: receipt.draft.reason }),
    ...(receipt.publish?.reason === undefined ? {} : { reason: receipt.publish.reason }),
  };
}

function readConfig(env = process.env) {
  const publicationUrl = normalizePublicationUrl(
    env.SUBSTACK_PUBLICATION_URL || ALLOWED_PUBLICATION_URL,
  );
  if (publicationUrl !== ALLOWED_PUBLICATION_URL) {
    throw new PublisherError(
      500,
      'invalid_configuration',
      `SUBSTACK_PUBLICATION_URL must be exactly ${ALLOWED_PUBLICATION_URL}.`,
    );
  }
  const dataDir = path.resolve(env.SUBSTACK_DATA_DIR || '/data');
  return {
    token: env.SUBSTACK_PUBLISHER_TOKEN || '',
    port: parsePort(env.SUBSTACK_PUBLISHER_PORT, 3110, 'SUBSTACK_PUBLISHER_PORT'),
    chromePort: parsePort(env.SUBSTACK_CHROME_PORT, 9444, 'SUBSTACK_CHROME_PORT'),
    publicationUrl,
    titlePrefix: env.SUBSTACK_TITLE_PREFIX || '[TEST]',
    dataDir,
    mediaRoot: path.resolve(env.SUBSTACK_MEDIA_ROOT || '/app/data'),
    envKillSwitch: parseBoolean(env.SUBSTACK_PUBLISHER_KILL_SWITCH, true),
    webPublishEnabled: parseBoolean(env.SUBSTACK_WEB_PUBLISH_ENABLED, false),
  };
}

async function createKillSwitch(config) {
  const sentinel = path.join(config.dataDir, 'KILL_SWITCH');
  return async () => {
    if (config.envKillSwitch) return true;
    try {
      await access(sentinel);
      return true;
    } catch {
      return false;
    }
  };
}

function errorPayload(error) {
  if (error instanceof PublisherError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return {
    status: 500,
    body: {
      error: 'internal_error',
      message: 'Internal publisher error.',
    },
  };
}

export async function startServer(env = process.env) {
  const config = readConfig(env);
  if (config.token.length < 32) {
    throw new PublisherError(
      500,
      'invalid_configuration',
      'SUBSTACK_PUBLISHER_TOKEN must be at least 32 characters.',
    );
  }
  if (typeof WebSocket === 'undefined') {
    throw new PublisherError(
      500,
      'websocket_unavailable',
      'Run Node with --experimental-websocket.',
    );
  }

  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.mediaRoot, { recursive: true, mode: 0o700 });
  const receipts = new ReceiptStore(path.join(config.dataDir, 'receipts'));
  await receipts.init();
  const killSwitch = await createKillSwitch(config);
  const chrome = new ChromeBridge({
    port: config.chromePort,
    publicationUrl: config.publicationUrl,
  });
  const driver = new SubstackDriver({ chrome, killSwitch });
  const mutations = new MutationQueue();

  const server = http.createServer(async (request, response) => {
    try {
      if (!bearerAuthorized(request.headers.authorization, config.token)) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const requestUrl = new URL(request.url || '/', 'http://publisher.internal');
      const draftMatch = requestUrl.pathname.match(/^\/drafts\/([a-f0-9]{64})$/);
      const publishMatch = requestUrl.pathname.match(/^\/drafts\/([a-f0-9]{64})\/publish$/);

      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        const [engaged, auth] = await Promise.all([
          killSwitch(),
          chrome.inspectAuth().catch(() => ({
            state: 'chrome_unreachable',
            authenticated: false,
          })),
        ]);
        let state = 'ready';
        if (engaged) state = 'kill_switch_engaged';
        else if (auth.state !== 'authenticated') state = auth.state;
        else state = 'ready';
        sendJson(response, 200, {
          status: state,
          publicationUrl: config.publicationUrl,
          port: config.port,
          chrome: auth.state === 'chrome_unreachable' ? 'unreachable' : 'reachable',
          auth,
          killSwitchEngaged: engaged,
          webPublishEnabled: config.webPublishEnabled,
          writeCalibration: 'text_image_audio_video_ready',
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/drafts') {
        const body = await readJsonBody(request);
        const draft = validateDraftPayload(body, config);
        await assertMediaFiles(draft.media, config.mediaRoot);
        if (await killSwitch()) {
          throw new PublisherError(423, 'kill_switch_engaged', 'Publisher kill switch is engaged.');
        }
        const result = await mutations.run(async () => {
          const reserved = await receipts.reserveDraft(draft);
          if (reserved.replay) {
            return { status: 200, receipt: reserved.receipt, replay: true };
          }
          let receipt = await receipts.beginDraft(reserved.receipt.id);
          try {
            const outcome = await driver.createDraft(draft);
            if (outcome.state === 'auth_required' || outcome.state === 'calibration_required') {
              receipt = await receipts.markDraft(receipt.id, outcome.state, {
                reason: outcome.reason,
              });
              return { status: 409, receipt, replay: false };
            }
            if (outcome.state !== 'succeeded') {
              throw new Error('Unexpected Substack draft outcome.');
            }
            receipt = await receipts.markDraft(receipt.id, 'succeeded', {
              remoteDraftId: outcome.remoteDraftId,
              postId: outcome.postId || outcome.remoteDraftId,
              editorUrl: outcome.editorUrl,
              completedAt: nowIso(),
            });
            return { status: 201, receipt, replay: false };
          } catch (error) {
            if (error instanceof PublisherError && error.code === 'kill_switch_engaged') {
              await receipts.markDraft(receipt.id, 'failed_prewrite', {
                reason: error.code,
              });
              throw error;
            }
            const remote = error instanceof PublisherError ? error.details : null;
            await receipts.markDraft(receipt.id, 'uncertain', {
              reason: 'operation_interrupted_or_unclassified',
              ...(remote?.remoteDraftId === undefined
                ? {}
                : { remoteDraftId: remote.remoteDraftId }),
              ...(remote?.editorUrl === undefined ? {} : { editorUrl: remote.editorUrl }),
            });
            throw new PublisherError(
              409,
              'uncertain_outcome',
              'Draft outcome is uncertain; blind retry is blocked.',
              {
                id: receipt.id,
                ...(remote?.remoteDraftId === undefined
                  ? {}
                  : { remoteDraftId: remote.remoteDraftId }),
              },
            );
          }
        });
        sendJson(response, result.status, {
          ...publicReceipt(result.receipt),
          replay: result.replay,
        });
        return;
      }

      if (request.method === 'GET' && draftMatch) {
        const receipt = await receipts.read(draftMatch[1]);
        if (!receipt) throw new PublisherError(404, 'draft_not_found', 'Draft receipt not found.');
        sendJson(response, 200, publicReceipt(receipt));
        return;
      }

      if (request.method === 'POST' && publishMatch) {
        const body = await readJsonBody(request);
        const publishRequest = validatePublishPayload(body);
        if (!publishRequest.attemptId) {
          publishRequest.attemptId = `publish:${publishMatch[1]}`;
        }
        if (!config.webPublishEnabled) {
          throw new PublisherError(
            403,
            'web_publish_disabled',
            'SUBSTACK_WEB_PUBLISH_ENABLED is not enabled.',
          );
        }
        if (await killSwitch()) {
          throw new PublisherError(423, 'kill_switch_engaged', 'Publisher kill switch is engaged.');
        }
        const result = await mutations.run(async () => {
          const begun = await receipts.beginPublish(publishMatch[1], publishRequest);
          if (begun.replay) return { status: 200, receipt: begun.receipt, replay: true };
          let receipt = begun.receipt;
          try {
            const outcome = await driver.publishWeb(receipt);
            if (outcome.state === 'auth_required' || outcome.state === 'calibration_required') {
              receipt = await receipts.markPublish(receipt.id, outcome.state, {
                reason: outcome.reason,
              });
              return { status: 409, receipt, replay: false };
            }
            if (outcome.state !== 'succeeded') {
              throw new Error('Unexpected Substack publish outcome.');
            }
            receipt = await receipts.markPublish(receipt.id, 'succeeded', {
              postId: outcome.postId || receipt.postId,
              permalink: outcome.permalink || outcome.publishedUrl,
              completedAt: nowIso(),
              delivery: 'web_only',
            });
            return { status: 200, receipt, replay: false };
          } catch (error) {
            if (error instanceof PublisherError && error.code === 'kill_switch_engaged') {
              await receipts.markPublish(receipt.id, 'failed_prewrite', {
                reason: error.code,
              });
              throw error;
            }
            await receipts.markPublish(receipt.id, 'uncertain', {
              reason: 'operation_interrupted_or_unclassified',
            });
            throw new PublisherError(
              409,
              'uncertain_outcome',
              'Web publish outcome is uncertain; blind retry is blocked.',
              { id: receipt.id },
            );
          }
        });
        sendJson(response, result.status, {
          ...publicReceipt(result.receipt),
          replay: result.replay,
        });
        return;
      }

      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      const failure = errorPayload(error);
      sendJson(response, failure.status, failure.body);
    }
  });

  server.requestTimeout = 240_000;
  server.headersTimeout = 10_000;
  server.listen(config.port, '0.0.0.0', () => {
    // Deliberately log only non-secret, non-payload operational state.
    console.log(
      `[substack-publisher] internal API listening on port ${config.port}; `
      + `publication=${config.publicationUrl}; kill_switch=${config.envKillSwitch}; `
      + `web_publish=${config.webPublishEnabled}`,
    );
  });
  return { server, config };
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  startServer().then(({ server }) => {
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((error) => {
    const failure = errorPayload(error);
    console.error(`[substack-publisher] startup failed: ${failure.body.error}`);
    process.exit(1);
  });
}
