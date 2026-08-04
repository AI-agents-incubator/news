/**
 * Telegram publisher.
 * Sends content to a Telegram chat/channel via Bot API.
 * Splits long messages at item boundaries (max 4096 chars per message).
 */

const TG_MAX_LENGTH = 4096;
const INTER_MESSAGE_DELAY = 1000;

// Channel-only promotion, approved by the owner on 2026-07-20. Keep this
// separate from the incoming Telegram bot replies: it is appended only by the
// publishing path that sends digests and source posts to the configured channel.
export const TELEGRAM_CHANNEL_ASSISTANT_FOOTER = 'В нашем чате теперь поселился умный ИИ-ассистент: он по-человечески объяснит, с чего вам начать, нужен ли вам агент, автоматизация, Make/n8n, код или RAG с памятью, подскажет, что есть в курсе и сколько на это уйдёт времени, а если вопрос не по адресу — не станет надувать щёки и честно скажет; заходите, проверяйте, вдруг это тот самый собеседник, который наконец отвечает по делу. Чтобы обратиться к нему, отправьте одним сообщением /ask ваш вопрос. Справка — /help.';

/** Add the channel footer once, preserving an already-composed retry payload. */
export function appendTelegramChannelFooter(content) {
  const text = String(content || '').trim();
  if (text.endsWith(TELEGRAM_CHANNEL_ASSISTANT_FOOTER)) return text;
  return text
    ? `${text}\n\n${TELEGRAM_CHANNEL_ASSISTANT_FOOTER}`
    : TELEGRAM_CHANNEL_ASSISTANT_FOOTER;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split digest text into chunks that fit Telegram's 4096 char limit.
 * Splits at numbered item boundaries (e.g. "\n\n2. ") to keep items intact.
 */
function splitMessage(text, maxLength = TG_MAX_LENGTH) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cutAt = -1;

    // Find the last item boundary within the limit
    // Look for patterns like "\n\n5. " or "\n\n12. "
    const searchArea = remaining.slice(0, maxLength);
    const itemPattern = /\n\n\d+\.\s/g;
    let match;
    while ((match = itemPattern.exec(searchArea)) !== null) {
      cutAt = match.index;
    }

    // Fallback: split at last double newline
    if (cutAt <= 0) {
      const lastBreak = searchArea.lastIndexOf('\n\n');
      if (lastBreak > 0) cutAt = lastBreak;
    }

    // Last resort: hard cut
    if (cutAt <= 0) cutAt = maxLength;

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendOne(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    console.error('[telegram] API error:', data.description || JSON.stringify(data));
    return null;
  }

  return data.result.message_id;
}

/**
 * Send the text body, optionally resuming after already confirmed chunks.
 *
 * A partial result is explicit rather than a false success. Callers persist
 * `messageIds`, then call again with `skipChunks` to send only the unread tail.
 */
export async function publishToTelegram(botToken, chatId, content, { skipChunks = 0 } = {}) {
  if (!botToken || !chatId) {
    console.error('[telegram] Missing botToken or chatId');
    return null;
  }
  if (!Number.isInteger(skipChunks) || skipChunks < 0) {
    console.error('[telegram] skipChunks must be a non-negative integer');
    return null;
  }

  try {
    // Reserve space for the footer before splitting the original text. This
    // keeps the approved footer intact and only in the final full-text message
    // instead of allowing a 4096-char boundary to cut it in half.
    const supplied = String(content || '').trim();
    const body = supplied.endsWith(TELEGRAM_CHANNEL_ASSISTANT_FOOTER)
      ? supplied.slice(0, -TELEGRAM_CHANNEL_ASSISTANT_FOOTER.length).trimEnd()
      : supplied;
    const footerSuffix = body
      ? `\n\n${TELEGRAM_CHANNEL_ASSISTANT_FOOTER}`
      : TELEGRAM_CHANNEL_ASSISTANT_FOOTER;
    const chunks = body
      ? splitMessage(body, TG_MAX_LENGTH - footerSuffix.length)
      : [''];
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}${footerSuffix}`;
    if (skipChunks > chunks.length) {
      console.error(`[telegram] Cannot skip ${skipChunks} of ${chunks.length} message(s)`);
      return null;
    }
    console.log(`[telegram] Sending ${chunks.length - skipChunks} of ${chunks.length} message(s) to ${chatId}`);

    const messageIds = [];

    for (let i = skipChunks; i < chunks.length; i++) {
      let msgId = null;
      try {
        msgId = await sendOne(botToken, chatId, chunks[i]);
      } catch (err) {
        console.error('[telegram] Error sending chunk:', err.message);
      }
      if (!msgId) {
        return {
          messageId: messageIds[0] || null,
          messageIds,
          totalMessages: chunks.length,
          complete: false,
        };
      }
      messageIds.push(msgId);
      if (i < chunks.length - 1) await sleep(INTER_MESSAGE_DELAY);
    }

    return {
      messageId: messageIds[0] || null,
      messageIds,
      totalMessages: chunks.length,
      complete: true,
    };
  } catch (err) {
    console.error('[telegram] Error publishing:', err.message);
    return null;
  }
}
