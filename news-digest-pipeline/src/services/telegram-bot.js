import { insertArticle, getArticleCount } from '../db/index.js';

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Send a message via Telegram Bot API using fetch.
 */
async function sendMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`[telegram-bot] sendMessage failed: ${resp.status} ${body}`);
  }
}

/**
 * Register webhook URL with Telegram.
 */
async function setWebhook(botToken, webhookUrl, secretToken) {
  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message'],
    }),
  });

  const data = await resp.json();
  if (data.ok) {
    console.log(`[telegram-bot] Webhook set: ${webhookUrl}`);
  } else {
    console.error(`[telegram-bot] Failed to set webhook:`, data);
  }
  return data;
}

/**
 * Handle /status command.
 */
async function handleStatus(botToken, chatId) {
  const newCount = getArticleCount('new');
  const processingCount = getArticleCount('processing');
  const usedCount = getArticleCount('used');
  const totalCount = getArticleCount();

  const text = [
    '<b>📊 Статус</b>',
    '',
    `Новых: ${newCount}`,
    `В обработке: ${processingCount}`,
    `Использовано: ${usedCount}`,
    `Всего: ${totalCount}`,
  ].join('\n');

  await sendMessage(botToken, chatId, text);
}

/**
 * Handle /generate command - trigger manual digest generation.
 */
async function handleGenerate(botToken, chatId, config) {
  const newCount = getArticleCount('new');

  if (newCount === 0) {
    await sendMessage(botToken, chatId, '⚠️ Нет новых статей для дайджеста.');
    return;
  }

  await sendMessage(botToken, chatId, `⏳ Генерация дайджеста из ${newCount} статей...`);

  try {
    const { getNewArticles, getDb } = await import('../db/index.js');
    const { generateDigest } = await import('./digest-generator.js');

    const limit = Math.min(newCount, config.maxArticlesPerDigest);
    const articles = getNewArticles(limit);
    const db = getDb();

    const digestId = await generateDigest(db, articles, config);
    await sendMessage(botToken, chatId, `✅ Дайджест сгенерирован (${articles.length} статей). ID: ${digestId}`);
  } catch (err) {
    console.error('[telegram-bot] Generate error:', err);
    await sendMessage(botToken, chatId, `❌ Ошибка генерации: ${err.message}`);
  }
}

/**
 * Handle incoming message with URLs.
 */
async function handleUrls(botToken, chatId, text, config) {
  const urls = text.match(URL_REGEX);

  if (!urls || urls.length === 0) {
    await sendMessage(botToken, chatId, '⚠️ Не нашел ссылок в сообщении.');
    return;
  }

  // Deduplicate URLs within the same message
  const uniqueUrls = [...new Set(urls)];

  let saved = 0;
  let duplicates = 0;

  for (const url of uniqueUrls) {
    const result = insertArticle({
      url,
      title: '',
      content: '',
      source: 'telegram',
    });

    if (result.duplicate) {
      duplicates++;
    } else {
      saved++;
    }
  }

  const newCount = getArticleCount('new');

  let reply = `✓ Сохранено: ${saved}`;
  if (duplicates > 0) {
    reply += ` (дубликатов: ${duplicates})`;
  }
  reply += `\nВсего новых: ${newCount}`;

  if (newCount >= config.articleThreshold) {
    reply += `\n\n📰 Накопилось ${newCount} статей. Дайджест будет сгенерирован.`;
  }

  await sendMessage(botToken, chatId, reply);
}

/**
 * Process a single Telegram update object.
 */
export async function handleTelegramUpdate(update, config) {
  const message = update.message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const allowedChatId = String(config.telegramChatId);
  const botToken = config.telegramBotToken;

  // Security: only accept messages from the configured chat
  if (chatId !== allowedChatId) {
    console.warn(`[telegram-bot] Rejected message from chat_id=${chatId} (allowed: ${allowedChatId})`);
    return;
  }

  const text = message.text || '';

  // Handle commands
  if (text.startsWith('/status')) {
    await handleStatus(botToken, chatId);
    return;
  }

  if (text.startsWith('/generate')) {
    await handleGenerate(botToken, chatId, config);
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    const helpText = [
      '<b>News Digest Bot</b>',
      '',
      'Отправьте ссылку — она будет сохранена для дайджеста.',
      '',
      '/status — количество статей',
      '/generate — сгенерировать дайджест сейчас',
    ].join('\n');
    await sendMessage(botToken, chatId, helpText);
    return;
  }

  // Otherwise try to extract URLs
  await handleUrls(botToken, chatId, text, config);
}

/**
 * Setup Telegram bot: register webhook with Telegram API.
 */
export async function setupTelegramBot(config) {
  if (!config.telegramBotToken) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN not set, skipping webhook setup');
    return;
  }

  if (!config.baseUrl) {
    console.warn('[telegram-bot] BASE_URL not set, skipping webhook setup');
    return;
  }

  const webhookUrl = `${config.baseUrl}/api/telegram/webhook`;
  await setWebhook(config.telegramBotToken, webhookUrl, config.telegramWebhookSecret);
}
