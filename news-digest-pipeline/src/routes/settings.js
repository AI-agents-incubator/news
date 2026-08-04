import { Router } from 'express';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import config, { paths, reloadConfig } from '../config.js';
import { MODEL_CATALOG } from '../data/model-catalog.js';
import { isAuthenticated } from '../middleware/auth.js';
import { normalizeProviderBaseUrl } from '../services/provider-endpoints.js';

const router = Router();

const MAX_TEXT_BYTES = 100 * 1024; // ~100KB per text field

// .env keys that this API is allowed to write. Everything else is preserved
// untouched. Secrets are deliberately NOT in this list.
const ENV_WRITABLE = {
  claudeModel: 'CLAUDE_MODEL',
  llmVendor: 'LLM_VENDOR',
  anthropicBaseUrl: 'ANTHROPIC_BASE_URL',
  openaiBaseUrl: 'OPENAI_BASE_URL',
  openaiReasoningEffort: 'OPENAI_REASONING_EFFORT',
  articleThreshold: 'ARTICLE_THRESHOLD',
  maxArticlesPerDigest: 'MAX_ARTICLES_PER_DIGEST',
  checkIntervalMs: 'CHECK_INTERVAL_MS',
  activeScenario: 'ACTIVE_SCENARIO',
};

const LLM_VENDORS = ['anthropic', 'openai'];

// Suggested reasoning-effort levels for the OpenAI path. Empty string clears the
// setting (nothing is sent — current runtime default). The list is a hint, not
// an exhaustive contract: the generator tolerates an unsupported value by
// dropping `reasoning_effort` and retrying (see digest-generator.js), so any
// short token is accepted here rather than hard-validating against a vendor enum
// that changes between model families.
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

// Suggested model ids per vendor come from the shared catalog
// (src/data/model-catalog.js), which also carries pricing. The UI always
// allows entering a custom id, so this list is not exhaustive.

const SCENARIO_OPTIONS = [
  {
    id: 'sarcastic',
    name: 'Сарказм',
    subtitle: 'текущий',
    promptFile: 'prompt.md',
    description: 'Саркастичный, неформальный, скептический авторский тон. Системный промпт Фазы A берётся из prompt.md.',
  },
  {
    id: 'architect',
    name: 'Архитектор',
    subtitle: 'серьёзный · ещё не использовался',
    promptFile: 'prompt_deep.md',
    description: 'Холодный интеллект, техно-философия, метод «отъезжающей камеры». Системный промпт Фазы A берётся из prompt_deep.md.',
  },
];
const SCENARIO_IDS = SCENARIO_OPTIONS.map((o) => o.id);

/**
 * Mask a secret value. Returns { configured, hint } and never the raw secret.
 */
function maskSecret(value) {
  if (!value) return { configured: false, hint: '' };
  const str = String(value);
  const tail = str.length >= 4 ? str.slice(-4) : str;
  return { configured: true, hint: `…${tail}` };
}

/**
 * Build the full grouped settings payload. Secrets are always masked.
 */
function buildSettingsPayload() {
  return {
    general: {
      llmVendor: { value: config.llmVendor, editable: true },
      model: { value: config.claudeModel, editable: true },
      // kept for backwards compatibility; UI uses `model`
      claudeModel: { value: config.claudeModel, editable: true },
      anthropicBaseUrl: {
        value: config.anthropicBaseUrl,
        editable: true,
        placeholder: 'https://api.anthropic.com',
      },
      openaiBaseUrl: {
        value: config.openaiBaseUrl,
        editable: true,
        placeholder: 'https://api.openai.com/v1',
      },
      openaiReasoningEffort: {
        value: config.openaiReasoningEffort,
        editable: true,
        suggestions: REASONING_EFFORTS,
      },
      modelCatalog: MODEL_CATALOG,
      nodeEnv: { value: config.nodeEnv, editable: false },
      baseUrl: { value: config.baseUrl, editable: false },
      dbPath: { value: config.dbPath, editable: false },
      ntfyTopic: { value: config.ntfyTopic, editable: false },
    },
    queue: {
      articleThreshold: { value: config.articleThreshold, editable: true },
      maxArticlesPerDigest: { value: config.maxArticlesPerDigest, editable: true },
      checkIntervalMs: {
        value: config.checkIntervalMs,
        editable: true,
        note: 'Применяется после рестарта сервера',
      },
    },
    commentary: { text: config.commentaryPrompt, editable: true },
    assembly: { text: config.assemblyPrompt, editable: true },
    deep: { text: config.deepPrompt, editable: true },
    scenarios: {
      active: config.activeScenario || 'sarcastic',
      options: SCENARIO_OPTIONS,
    },
    content: {
      text: config.configMdRaw,
      editable: true,
      parsed: {
        hashtag: config.hashtag,
        courseMention: config.courseMention,
        boundaryIntent: config.boundaryIntent,
        hashtagsSuffix: config.hashtagsSuffix,
      },
    },
    publishing: {
      editable: false,
      telegram: {
        botToken: maskSecret(config.telegramBotToken),
        chatId: maskSecret(config.telegramChatId),
        publishChatId: maskSecret(config.telegramPublishChatId),
        webhookSecret: maskSecret(config.telegramWebhookSecret),
      },
      facebook: {
        pageId: maskSecret(config.facebookPageId),
        pageAccessToken: maskSecret(config.facebookPageAccessToken),
      },
      getresponse: {
        apiKey: maskSecret(config.getresponseApiKey),
        campaignId: maskSecret(config.getresponseCampaignId),
        fromFieldId: maskSecret(config.getresponseFromFieldId),
        configured: !!(config.getresponseApiKey && config.getresponseCampaignId),
        delivery: 'draft_only',
      },
      substack: {
        publisherUrl: config.substackPublisherUrl || '',
        publisherToken: maskSecret(config.substackPublisherToken),
        publicationUrl: config.substackPublicationUrl || '',
        mode: config.substackMode || 'draft_only',
        titlePrefix: config.substackTitlePrefix ?? '[TEST]',
        webPublishEnabled: config.substackWebPublishEnabled === true,
        configured: !!(
          config.substackPublisherUrl
          && config.substackPublisherToken
          && config.substackPublicationUrl
        ),
        emailDelivery: 'disabled',
      },
      anthropicApiKey: maskSecret(config.anthropicApiKey),
      openaiApiKey: maskSecret(config.openaiApiKey),
      falKey: maskSecret(config.falKey),
      // Planned integrations — pipelines not implemented yet, status only.
      // Secrets are not editable via API (only via .env), like all other secrets.
      planned: {
        instagram: {
          accessToken: maskSecret(config.instagramAccessToken),
          accountId: maskSecret(config.instagramAccountId),
          status: 'Пайплайн не реализован — нужно добавить',
        },
        tiktok: {
          accessToken: maskSecret(config.tiktokAccessToken),
          status: 'Пайплайн не реализован — нужно добавить',
        },
        youtube: {
          accessToken: maskSecret(config.youtubeAccessToken),
          channelId: maskSecret(config.youtubeChannelId),
          status: 'Community Posts API недоступен — заглушка',
        },
        gemini: {
          apiKey: maskSecret(config.geminiApiKey),
          status: 'API-ключ для будущих пайплайнов — нужно добавить',
        },
      },
    },
  };
}

/**
 * Atomically write a string to a file: write to a temp sibling, then rename.
 */
function atomicWrite(filePath, contents) {
  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmpPath, contents, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Update only the allowed keys in .env, preserving all other lines, comments,
 * blank lines and unrelated secrets. Missing keys are appended. Atomic write.
 *
 * @param {Object<string,string>} updates Map of ENV_KEY -> value (already validated)
 */
function updateEnvFile(updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  // Persist dashboard edits to the overrides file on the mounted ./data volume,
  // NOT the base .env (which is read-only on the server and rebuilt with the
  // image). See paths.settingsEnv in config.js.
  let raw = '';
  if (existsSync(paths.settingsEnv)) {
    raw = readFileSync(paths.settingsEnv, 'utf-8');
  }

  // Preserve original EOL convention.
  const hadTrailingNewline = raw.length === 0 || raw.endsWith('\n');
  const lines = raw.length ? raw.split('\n') : [];
  const remaining = new Set(keys);

  const out = lines.map((line) => {
    // Match `KEY=...` allowing leading whitespace, but not commented lines.
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) {
      const key = m[2];
      if (remaining.has(key)) {
        remaining.delete(key);
        return `${m[1]}${key}=${updates[key]}`;
      }
    }
    return line;
  });

  // If the file ended with a trailing newline, split() produced a final ''
  // element. Drop it before appending so we don't create blank-line drift.
  if (out.length && out[out.length - 1] === '' && hadTrailingNewline) {
    out.pop();
  }

  for (const key of remaining) {
    out.push(`${key}=${updates[key]}`);
  }

  // Header for a freshly created overrides file (self-documenting).
  if (raw.length === 0) {
    out.unshift(
      '# Dashboard-editable settings (overrides base .env). Managed by the',
      '# settings API — do not hand-edit while the server is running.',
    );
  }

  atomicWrite(paths.settingsEnv, out.join('\n') + '\n');
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Validate the incoming PATCH body. Returns { errors: [], env: {}, files: [] }.
 * Only known/allowed fields are considered; everything else is ignored.
 */
export function validatePatch(body) {
  const errors = [];
  const env = {};   // ENV_KEY -> string value to write
  const files = []; // [{ path, contents }]

  // --- .env scalar fields ---
  // Model id: accept both `model` and `claudeModel` as aliases (UI sends the
  // selected/custom id). Both write to CLAUDE_MODEL.
  const modelValue = body.model !== undefined ? body.model
    : body.claudeModel !== undefined ? body.claudeModel
    : undefined;
  if (modelValue !== undefined) {
    const v = modelValue;
    if (typeof v !== 'string' || v.trim().length === 0) {
      errors.push('claudeModel: должна быть непустой строкой');
    } else if (v.length > 200) {
      errors.push('claudeModel: слишком длинная строка (макс. 200 символов)');
    } else if (/[\n\r]/.test(v)) {
      errors.push('claudeModel: не должна содержать переносы строк');
    } else {
      env[ENV_WRITABLE.claudeModel] = v.trim();
    }
  }

  // LLM vendor selector — strictly anthropic|openai.
  if (body.llmVendor !== undefined) {
    const v = body.llmVendor;
    if (typeof v !== 'string' || !LLM_VENDORS.includes(v)) {
      errors.push(`llmVendor: должно быть одним из ${LLM_VENDORS.join(', ')}`);
    } else {
      env[ENV_WRITABLE.llmVendor] = v;
    }
  }

  // Base URLs. Empty string is allowed (resets to vendor default) and is still
  // written to .env so the user can explicitly clear it. Non-empty values must
  // be the official provider HTTPS root; accepting arbitrary hosts would let a
  // compromised dashboard session exfiltrate API keys and prompt/article data.
  const baseUrlField = (name, vendor, envKey) => {
    if (body[name] === undefined) return;
    const v = body[name];
    if (typeof v !== 'string') {
      errors.push(`${name}: должно быть строкой`);
      return;
    }
    if (v.length > 300) {
      errors.push(`${name}: слишком длинная строка (макс. 300 символов)`);
      return;
    }
    if (/[\n\r]/.test(v)) {
      errors.push(`${name}: не должно содержать переносы строк`);
      return;
    }
    const normalized = normalizeProviderBaseUrl(vendor, v);
    if (normalized === null) {
      errors.push(`${name}: допустим только официальный HTTPS endpoint ${vendor} или пустое значение`);
      return;
    }
    env[envKey] = normalized;
  };

  baseUrlField('anthropicBaseUrl', 'anthropic', ENV_WRITABLE.anthropicBaseUrl);
  baseUrlField('openaiBaseUrl', 'openai', ENV_WRITABLE.openaiBaseUrl);

  // OpenAI reasoning effort. Empty string is allowed and written so the user can
  // explicitly clear it (nothing gets sent at runtime). Non-empty must be a short
  // lowercase token; we do not hard-validate against a fixed vendor enum because
  // the generator self-heals unsupported values.
  if (body.openaiReasoningEffort !== undefined) {
    const v = body.openaiReasoningEffort;
    if (typeof v !== 'string') {
      errors.push('openaiReasoningEffort: должно быть строкой');
    } else if (v.length > 20) {
      errors.push('openaiReasoningEffort: слишком длинная строка (макс. 20 символов)');
    } else if (v.length > 0 && !/^[a-z]+$/i.test(v)) {
      errors.push('openaiReasoningEffort: только латинские буквы (например minimal, low, medium, high)');
    } else {
      env[ENV_WRITABLE.openaiReasoningEffort] = v.trim().toLowerCase();
    }
  }

  const intField = (name, min, max) => {
    if (body[name] === undefined) return;
    const v = body[name];
    if (!isInt(v)) {
      errors.push(`${name}: должно быть целым числом`);
    } else if (v < min || v > max) {
      errors.push(`${name}: должно быть в диапазоне ${min}..${max}`);
    } else {
      env[ENV_WRITABLE[name]] = String(v);
    }
  };

  intField('articleThreshold', 1, 100);
  intField('maxArticlesPerDigest', 1, 100);
  intField('checkIntervalMs', 5000, 3600000);

  // --- scenario selector ---
  if (body.activeScenario !== undefined) {
    const v = body.activeScenario;
    if (typeof v !== 'string' || !SCENARIO_IDS.includes(v)) {
      errors.push(`activeScenario: должно быть одним из ${SCENARIO_IDS.join(', ')}`);
    } else {
      env[ENV_WRITABLE.activeScenario] = v;
    }
  }

  // --- text/file fields ---
  const textField = (name, targetPath) => {
    const group = body[name];
    if (group === undefined) return;
    const text = group && typeof group === 'object' ? group.text : group;
    if (text === undefined) return;
    if (typeof text !== 'string') {
      errors.push(`${name}.text: должно быть строкой`);
    } else if (Buffer.byteLength(text, 'utf-8') > MAX_TEXT_BYTES) {
      errors.push(`${name}.text: слишком большой (макс. 100KB)`);
    } else {
      files.push({ path: targetPath, contents: text });
    }
  };

  textField('commentary', paths.commentaryPrompt);
  textField('assembly', paths.assemblyPrompt);
  textField('deep', paths.deepPrompt);
  textField('content', paths.configMd);

  return { errors, env, files };
}

/**
 * Strip the sensitive prompt/config text for unauthenticated viewers. The
 * prompts are the product's IP: anonymous visitors may browse the settings
 * structure, but must not be able to read or copy the actual prompt/config
 * bodies. Redacting server-side makes copying impossible (not just hidden in
 * the UI) — the text never reaches the client.
 */
function redactForAnon(payload) {
  payload.locked = true;
  const lock = (obj) => { if (obj && typeof obj === 'object') { obj.text = ''; obj.locked = true; obj.editable = false; } };
  lock(payload.commentary);
  lock(payload.assembly);
  lock(payload.deep);
  if (payload.content) {
    payload.content.text = '';
    payload.content.locked = true;
    payload.content.editable = false;
    payload.content.parsed = {};
  }
  return payload;
}

// GET /api/settings — full grouped settings, secrets masked. Prompt/config
// bodies are redacted for unauthenticated callers.
router.get('/', (req, res) => {
  try {
    const payload = buildSettingsPayload();
    if (!isAuthenticated(req)) redactForAnon(payload);
    res.json(payload);
  } catch (err) {
    console.error('[settings] GET error:', err.message);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

// PATCH /api/settings — partial update of allowed fields only
router.patch('/', (req, res) => {
  const body = req.body || {};
  const { errors, env, files } = validatePatch(body);

  if (errors.length) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  if (Object.keys(env).length === 0 && files.length === 0) {
    return res.status(400).json({ error: 'Нет допустимых полей для изменения' });
  }

  try {
    // Write text files first (each atomic), then .env (atomic).
    for (const f of files) {
      atomicWrite(f.path, f.contents);
    }
    updateEnvFile(env);

    reloadConfig();

    return res.json(buildSettingsPayload());
  } catch (err) {
    console.error('[settings] PATCH error:', err.message);
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
