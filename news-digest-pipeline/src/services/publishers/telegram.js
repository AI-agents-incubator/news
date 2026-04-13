/**
 * Telegram publisher.
 * Sends content to a Telegram chat/channel via Bot API.
 * Splits long messages at item boundaries (max 4096 chars per message).
 */

const TG_MAX_LENGTH = 4096;
const INTER_MESSAGE_DELAY = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split digest text into chunks that fit Telegram's 4096 char limit.
 * Splits at numbered item boundaries (e.g. "\n\n2. ") to keep items intact.
 */
function splitMessage(text) {
  if (text.length <= TG_MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > TG_MAX_LENGTH) {
    let cutAt = -1;

    // Find the last item boundary within the limit
    // Look for patterns like "\n\n5. " or "\n\n12. "
    const searchArea = remaining.slice(0, TG_MAX_LENGTH);
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
    if (cutAt <= 0) cutAt = TG_MAX_LENGTH;

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

export async function publishToTelegram(botToken, chatId, content) {
  if (!botToken || !chatId) {
    console.error('[telegram] Missing botToken or chatId');
    return null;
  }

  try {
    const chunks = splitMessage(content);
    console.log(`[telegram] Sending ${chunks.length} message(s) to ${chatId}`);

    const messageIds = [];

    for (let i = 0; i < chunks.length; i++) {
      const msgId = await sendOne(botToken, chatId, chunks[i]);
      if (msgId) messageIds.push(msgId);
      if (i < chunks.length - 1) await sleep(INTER_MESSAGE_DELAY);
    }

    if (messageIds.length === 0) return null;

    return { messageId: messageIds[0], totalMessages: messageIds.length };
  } catch (err) {
    console.error('[telegram] Error publishing:', err.message);
    return null;
  }
}
