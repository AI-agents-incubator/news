import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requireOfficialProviderBaseUrl } from './services/provider-endpoints.js';

dotenvConfig();

const __dirname = dirname(fileURLToPath(import.meta.url));
const parentDir = join(__dirname, '..');  // news-digest-pipeline root
const newsRoot = join(parentDir, '..');   // News/ directory with prompt files

// Prompts are looked up in three places, in order:
//   1. /app/prompts        — Docker volume mount
//   2. <pipeline>/prompts  — bare-metal (systemd) deploy ships them here
//   3. News/ parent dir    — local dev
const dockerPromptsDir = '/app/prompts';
const localPromptsDir = join(parentDir, 'prompts');
const promptsDir = existsSync(join(dockerPromptsDir, 'prompt.md'))
  ? dockerPromptsDir
  : existsSync(join(localPromptsDir, 'prompt.md'))
  ? localPromptsDir
  : newsRoot;

// Absolute paths to all editable source files. Exported so the settings API
// can read/write the exact same files config.js loads from.
export const paths = {
  promptsDir,
  commentaryPrompt: join(promptsDir, 'prompt.md'),
  assemblyPrompt: join(promptsDir, 'assembly_prompt.md'),
  deepPrompt: join(promptsDir, 'prompt_deep.md'),
  configMd: join(promptsDir, 'config.md'),
  // Base .env — secrets + defaults. Loaded via docker-compose env_file at
  // startup; NOT written by the dashboard.
  env: join(parentDir, '.env'),
  // Dashboard-editable settings are persisted here as env-style overrides. It
  // lives inside the mounted ./data volume, so — unlike the base .env, which
  // sits in the image's ephemeral layer on the server — it survives image
  // rebuilds and is on a read-write mount where atomic writes succeed.
  // DATA_DIR overrides the volume location. Production never sets it (the compose
  // mount is ./data); it exists so an offline bench can point the SAME code at a
  // COPY of the production knowledge volume without writing into the repo's data/,
  // which the test suite owns and freely deletes files from.
  settingsEnv: join(process.env.DATA_DIR || join(parentDir, 'data'), 'settings.env'),
};

// Apply persisted dashboard overrides on top of the base environment. `override`
// so a saved value wins over the base .env default; loaded again in
// reloadConfig() so a save applies live without a restart.
if (existsSync(paths.settingsEnv)) {
  dotenvConfig({ path: paths.settingsEnv, override: true });
}

function readFileOrWarn(filePath, label) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[config] Warning: could not read ${label} at ${filePath}`);
    return '';
  }
}

export function parseConfigMd(text) {
  const result = {
    hashtag: '#новости',
    courseMention: '',
    boundaryIntent: '',
    hashtagsSuffix: '',
  };

  if (!text) return result;

  const sections = text.split(/^## /m);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const heading = lines[0]?.trim().toLowerCase() || '';
    const body = lines.slice(1).join('\n').trim();

    if (heading.startsWith('хэштег') || heading.startsWith('хештег')) {
      result.hashtag = body.trim() || '#новости';
    } else if (heading.includes('упоминание курса')) {
      result.courseMention = body.trim();
    } else if (heading.includes('граница') || heading.includes('отписка')) {
      // `config.md` deliberately contains editorial instructions around the
      // literal footer. They are not part of the reader-facing copy. Keeping
      // the split here makes the code assembler deterministic and prevents an
      // instruction such as "Вставлять ДОСЛОВНО" from leaking into Telegram.
      const literalBody = body
        .replace(/^Вставлять\s+ДОСЛОВНО,\s*без\s+изменений:\s*/i, '')
        .trim();
      result.boundaryIntent = literalBody
        .split(/\n\s*добавлять в конце поста хе[шс]теги:\s*/i)[0]
        .trim();
    } else if (heading.startsWith('вставлять дословно')) {
      // The production settings file keeps the literal footer in its own
      // heading. Accept that equivalent structure as well as the historical
      // inline instruction under "Граница".
      result.boundaryIntent = body.trim();
    } else if (/^вставлять хе[шс]теги/.test(heading)) {
      result.hashtagsSuffix = body.trim();
    }
  }

  // Extract hashtags suffix from boundary section or end of file
  const hashtagMatch = text.match(/добавлять в конце поста хе[шс]теги:\s*\n+([\s\S]*?)(?:\n##|\n\n\n|$)/i);
  if (hashtagMatch) {
    result.hashtagsSuffix = hashtagMatch[1].trim();
  }

  return result;
}

/**
 * Build the full settings object from the current environment and source files.
 * Pure read — does not mutate anything.
 */
function buildConfig() {
  const commentaryPrompt = readFileOrWarn(paths.commentaryPrompt, 'prompt.md');
  const assemblyPrompt = readFileOrWarn(paths.assemblyPrompt, 'assembly_prompt.md');
  const deepPrompt = readFileOrWarn(paths.deepPrompt, 'prompt_deep.md');
  const configMdRaw = readFileOrWarn(paths.configMd, 'config.md');
  const parsedConfig = parseConfigMd(configMdRaw);

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    falKey: process.env.FAL_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',

    // LLM vendor selection. claudeModel above is the active model id, shared by
    // both vendors (it just holds whatever model id the user picked).
    llmVendor: process.env.LLM_VENDOR || 'anthropic', // 'anthropic' | 'openai'
    // Empty selects the SDK default. Any non-empty value is verified here as
    // well as in Settings so a hand-edited .env cannot redirect API keys and
    // prompts to an arbitrary host.
    anthropicBaseUrl: requireOfficialProviderBaseUrl('anthropic', process.env.ANTHROPIC_BASE_URL || ''),
    openaiBaseUrl: requireOfficialProviderBaseUrl('openai', process.env.OPENAI_BASE_URL || ''),
    openaiApiKey: process.env.OPENAI_API_KEY || '', // secret
    openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '', // secret (planned integrations)
    dbPath: process.env.DB_PATH || './data/news-digest.db',
    ntfyTopic: process.env.NTFY_TOPIC || '',
    articleThreshold: parseInt(process.env.ARTICLE_THRESHOLD || '13', 10),
    maxArticlesPerDigest: parseInt(process.env.MAX_ARTICLES_PER_DIGEST || '17', 10),
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10),
    // A worker must renew this lease while generating a digest. On a crash, the
    // next automatic claim returns the expired batch to `new` instead of leaving
    // it permanently stuck in `processing`.
    processingLeaseMs: parseInt(process.env.PROCESSING_LEASE_MS || '1800000', 10),
    // Max consecutive failed fetch attempts before the local fetcher gives up on
    // an article and it is flipped to the terminal 'unfetchable' status (stops
    // the endless Chrome re-open loop on URLs that never yield content).
    maxFetchAttempts: parseInt(process.env.MAX_FETCH_ATTEMPTS || '5', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    // Active commentary scenario for Phase A: 'sarcastic' (prompt.md) or
    // 'architect' (prompt_deep.md). Assembly (Phase B) is scenario-independent.
    activeScenario: process.env.ACTIVE_SCENARIO || 'sarcastic',

    // Publishers
    facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
    facebookPageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramPublishChatId: process.env.TELEGRAM_PUBLISH_CHAT_ID || '',
    youtubeAccessToken: process.env.YOUTUBE_ACCESS_TOKEN || '',
    youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',

    // Email syndication via GetResponse (pro cluster, Autoposter). DRAFT-ONLY
    // by design: the autoposter creates a draft newsletter and never sends it —
    // the owner reviews and presses "send" inside GetResponse. API key is a
    // secret; campaign id selects where the draft lands; from-field id is
    // optional (empty → first available from-field is used).
    getresponseApiKey: process.env.GETRESPONSE_API_KEY || '',
    getresponseCampaignId: process.env.GETRESPONSE_CAMPAIGN_ID || '',
    getresponseFromFieldId: process.env.GETRESPONSE_FROM_FIELD_ID || '',

    // Substack syndication is performed by a separate server-side headed
    // Chrome worker with a persistent profile. The main app never receives
    // Substack cookies or account credentials. `draft_only` is the fail-closed
    // default; web publication additionally requires the worker-side kill
    // switch. Substack email sending is not supported by this pipeline.
    substackPublisherUrl: process.env.SUBSTACK_PUBLISHER_URL || '',
    substackPublisherToken: process.env.SUBSTACK_PUBLISHER_TOKEN || '',
    substackPublicationUrl: process.env.SUBSTACK_PUBLICATION_URL || '',
    substackMode: process.env.SUBSTACK_MODE || 'draft_only',
    substackTitlePrefix: process.env.SUBSTACK_TITLE_PREFIX ?? '[TEST]',
    substackWebPublishEnabled: (process.env.SUBSTACK_WEB_PUBLISH_ENABLED || 'false') === 'true',

    // Instagram syndication (pro cluster, Autoposter). Graph API container→publish
    // flow. A source image is used as-is; a no-image post prepares a persisted,
    // text-grounded visual through FAL when configured, otherwise OpenAI Images.
    // There is deliberately no static placeholder-image configuration.
    instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
    instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID || '',
    // Threads uses its own OAuth token and Threads user id. The publisher keeps
    // its two-step container/publish receipt in source_posts so a lost response
    // can never turn a retry into a duplicate public Thread.
    threadsAccessToken: process.env.THREADS_ACCESS_TOKEN || '',
    threadsUserId: process.env.THREADS_USER_ID || '',
    tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN || '',

    // Facebook Page comment moderation (News Pro only). Telegram moderation,
    // the assistant and Gatekeeper are configured in the separate AIchatTG app.
    moderationMode: process.env.MODERATION_MODE || 'shadow', // shadow | live
    moderationModel: process.env.MODERATION_MODEL || '',
    moderationVendor: process.env.MODERATION_VENDOR || '',
    moderationImproverModel: process.env.MODERATION_IMPROVER_MODEL || '',
    moderationBanThreshold: parseFloat(process.env.MODERATION_BAN_THRESHOLD || '0.85'),
    moderationOwnerAuthorIds: new Set(
      (process.env.MODERATION_OWNER_AUTHOR_IDS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
    ),
    moderationHardDelete: (process.env.MODERATION_HARD_DELETE || 'false') === 'true',
    moderationPollPostLookback: parseInt(process.env.MODERATION_POLL_POST_LOOKBACK || '5', 10),
    moderationPollIntervalMs: parseInt(process.env.MODERATION_POLL_INTERVAL_MS || '300000', 10),

    // Telegram webhook
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    baseUrl: process.env.BASE_URL || '',

    // FB Watcher — profile scanned by the read-only poller (Module 1).
    fbProfileUrl: process.env.FB_PROFILE_URL || 'https://www.facebook.com/alex.v.krol',

    // Raw config.md text (kept for the settings editor)
    configMdRaw,

    // Prompts (loaded from parent directory files)
    commentaryPrompt,
    assemblyPrompt,
    deepPrompt,

    // Parsed config.md values
    hashtag: parsedConfig.hashtag,
    courseMention: parsedConfig.courseMention,
    boundaryIntent: parsedConfig.boundaryIntent,
    hashtagsSuffix: parsedConfig.hashtagsSuffix,
  };
}

// Live config object. NOT frozen — importers hold this reference and read
// properties at call time, so reloadConfig() mutating it in place propagates.
const appConfig = buildConfig();

/**
 * Reload configuration in place: re-read .env (override existing process.env),
 * re-read the four source files, re-parse config.md, then reassign every
 * property on the SAME appConfig object so existing importers see new values.
 * Returns the same appConfig reference.
 */
export function reloadConfig() {
  dotenvConfig({ path: paths.env, override: true });
  if (existsSync(paths.settingsEnv)) {
    dotenvConfig({ path: paths.settingsEnv, override: true });
  }
  const fresh = buildConfig();

  // Drop properties that no longer exist, then copy fresh values in place.
  for (const key of Object.keys(appConfig)) {
    if (!(key in fresh)) delete appConfig[key];
  }
  Object.assign(appConfig, fresh);

  return appConfig;
}

export default appConfig;
