import { insertArticle, getArticleCount, getReadyArticleCount } from '../db/index.js';
import { validateArticleUrl } from './url-validator.js';

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
  const readyCount = getReadyArticleCount();
  const processingCount = getArticleCount('processing');
  const usedCount = getArticleCount('used');
  const totalCount = getArticleCount();

  const text = [
    '<b>📊 Статус</b>',
    '',
    `Новых: ${newCount}`,
    `Готово к дайджесту: ${readyCount}`,
    `В обработке: ${processingCount}`,
    `Использовано: ${usedCount}`,
    `Всего: ${totalCount}`,
  ].join('\n');

  await sendMessage(botToken, chatId, text);
}

/**
 * Handle /generate command - trigger manual digest generation.
 */
export async function handleGenerate(botToken, chatId, config, {
  claimArticles,
  getDatabase,
  generatePhase1,
  getReviewRun,
} = {}) {
  try {
    const {
      claimReadyArticles,
      getDb,
      getDigestReviewRun,
      getOpenQueueDigestReviewRun,
    } = await import('../db/index.js');
    const { CLASSIC_DIGEST_TARGET_SIZE, generateDigest } = await import('./digest-generator.js');

    const openRun = getOpenQueueDigestReviewRun();
    if (openRun) {
      await sendMessage(
        botToken,
        chatId,
        `⚠️ Предыдущий первый проход требует восстановления в панели дайджеста. Новый batch не взят. Run ID: ${openRun.id}`
      );
      return;
    }

    const articles = (claimArticles || claimReadyArticles)({
      limit: CLASSIC_DIGEST_TARGET_SIZE,
      threshold: CLASSIC_DIGEST_TARGET_SIZE,
      leaseMs: config.processingLeaseMs,
    });
    if (articles.length === 0) {
      await sendMessage(botToken, chatId, '⚠️ Для полного batch пока недостаточно готовых статей. Материалы без текста ещё извлекаются.');
      return;
    }

    await sendMessage(botToken, chatId, `⏳ Этап 1: обработка ${articles.length} готовых статей...`);

    const db = (getDatabase || getDb)();

    const runId = await (generatePhase1 || generateDigest)(db, articles, config, {
      leaseId: articles[0].processing_lease_id,
    });
    const run = (getReviewRun || getDigestReviewRun)(runId);
    if (run?.status === 'failed') {
      await sendMessage(
        botToken,
        chatId,
        `❌ Этап 1 завершился с ошибкой. Откройте проход в панели дайджеста. Run ID: ${runId}`
      );
      return;
    }
    if (run?.status === 'phase1_processing' || run?.status === 'phase1_attention_required') {
      await sendMessage(
        botToken,
        chatId,
        `⚠️ Этап 1 остановлен и требует явного восстановления в панели дайджеста. Автоматического повтора модели не было. Run ID: ${runId}`
      );
      return;
    }
    await sendMessage(
      botToken,
      chatId,
      `✅ Этап 1 завершён (${articles.length} статей). Проверьте новости в панели дайджеста. Run ID: ${runId}`
    );
  } catch (err) {
    console.error('[telegram-bot] Generate error:', err);
    await sendMessage(botToken, chatId, `❌ Ошибка генерации: ${err.message}`);
  }
}

/**
 * Delete a message via Telegram Bot API. Returns true on success.
 * In private chats the bot can only delete its own messages; in groups/channels
 * it needs admin rights with can_delete_messages.
 */
export async function deleteTelegramMessage(botToken, chatId, messageId) {
  const url = `https://api.telegram.org/bot${botToken}/deleteMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  const data = await resp.json();
  return !!data.ok;
}

/**
 * Handle incoming message with URLs.
 */
async function handleUrls(botToken, chatId, messageId, text, config) {
  const urls = text.match(URL_REGEX);

  if (!urls || urls.length === 0) {
    await sendMessage(botToken, chatId, '⚠️ Не нашел ссылок в сообщении.');
    return;
  }

  // Deduplicate URLs within the same message
  const uniqueUrls = [...new Set(urls)];

  // Filter + normalize via the shared article-URL contract (HTTPS +
  // perplexity.ai + no control chars). Store only the normalized href.
  const validUrls = [];
  for (const u of uniqueUrls) {
    const v = validateArticleUrl(u);
    if (v.ok) validUrls.push(v.href);
  }

  const rejected = uniqueUrls.length - validUrls.length;
  if (validUrls.length === 0) {
    let reply = '⚠️ Не нашел допустимых ссылок (принимаются только perplexity.ai).';
    if (rejected > 0) reply += `\nОтклонено: ${rejected}`;
    await sendMessage(botToken, chatId, reply);
    return;
  }

  let saved = 0;
  let duplicates = 0;

  for (const url of validUrls) {
    const result = insertArticle({
      url,
      title: '',
      content: '',
      source: 'telegram',
      sourceChatId: String(chatId),
      sourceMessageId: messageId != null ? String(messageId) : null,
    });

    if (result.duplicate) {
      duplicates++;
    } else {
      saved++;
    }
  }

  const newCount = getArticleCount('new');
  const readyCount = getReadyArticleCount();

  let reply = `✓ Сохранено: ${saved}`;
  if (duplicates > 0) {
    reply += ` (дубликатов: ${duplicates})`;
  }
  if (rejected > 0) {
    reply += ` (отклонено: ${rejected})`;
  }
  reply += `\nВсего новых: ${newCount}`;

  if (readyCount >= config.articleThreshold) {
    reply += `\n\n📰 Готово ${readyCount} статей. Дайджест будет сгенерирован.`;
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
      '/generate — выполнить этап 1 и отправить новости на проверку',
    ].join('\n');
    await sendMessage(botToken, chatId, helpText);
    return;
  }

  // Otherwise try to extract URLs
  await handleUrls(botToken, chatId, message.message_id, text, config);
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
