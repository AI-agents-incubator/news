import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenvConfig();

const __dirname = dirname(fileURLToPath(import.meta.url));
const parentDir = join(__dirname, '..');  // news-digest-pipeline root
const newsRoot = join(parentDir, '..');   // News/ directory with prompt files

// Docker mounts prompts at /app/prompts/; locally they live in the parent News/ dir
const dockerPromptsDir = '/app/prompts';
const promptsDir = existsSync(join(dockerPromptsDir, 'prompt.md'))
  ? dockerPromptsDir
  : newsRoot;

function readFileOrWarn(filePath, label) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[config] Warning: could not read ${label} at ${filePath}`);
    return '';
  }
}

function parseConfigMd(text) {
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
      result.boundaryIntent = body.trim();
    }
  }

  // Extract hashtags suffix from boundary section or end of file
  const hashtagMatch = text.match(/добавлять в конце поста хе[шс]теги:\s*\n+([\s\S]*?)(?:\n##|\n\n\n|$)/i);
  if (hashtagMatch) {
    result.hashtagsSuffix = hashtagMatch[1].trim();
  }

  return result;
}

const commentaryPrompt = readFileOrWarn(join(promptsDir, 'prompt.md'), 'prompt.md');
const assemblyPrompt = readFileOrWarn(join(promptsDir, 'assembly_prompt.md'), 'assembly_prompt.md');
const deepPrompt = readFileOrWarn(join(promptsDir, 'prompt_deep.md'), 'prompt_deep.md');
const configMdRaw = readFileOrWarn(join(promptsDir, 'config.md'), 'config.md');
const parsedConfig = parseConfigMd(configMdRaw);

const appConfig = Object.freeze({
  port: parseInt(process.env.PORT || '3000', 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  dbPath: process.env.DB_PATH || './data/news-digest.db',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  articleThreshold: parseInt(process.env.ARTICLE_THRESHOLD || '13', 10),
  maxArticlesPerDigest: parseInt(process.env.MAX_ARTICLES_PER_DIGEST || '17', 10),
  checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Publishers
  facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
  facebookPageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramPublishChatId: process.env.TELEGRAM_PUBLISH_CHAT_ID || '',
  youtubeAccessToken: process.env.YOUTUBE_ACCESS_TOKEN || '',
  youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',

  // Telegram webhook
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  baseUrl: process.env.BASE_URL || '',

  // Prompts (loaded from parent directory files)
  commentaryPrompt,
  assemblyPrompt,
  deepPrompt,

  // Parsed config.md values
  hashtag: parsedConfig.hashtag,
  courseMention: parsedConfig.courseMention,
  boundaryIntent: parsedConfig.boundaryIntent,
  hashtagsSuffix: parsedConfig.hashtagsSuffix,
});

export default appConfig;
