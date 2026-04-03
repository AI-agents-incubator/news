import { Router } from 'express';
import { handleTelegramUpdate } from '../services/telegram-bot.js';
import config from '../config.js';

const router = Router();

router.post('/webhook', (req, res) => {
  // Verify the secret token from Telegram header
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (config.telegramWebhookSecret && secretToken !== config.telegramWebhookSecret) {
    console.warn('[telegram] Invalid secret token in webhook request');
    return res.sendStatus(403);
  }

  // Respond immediately (Telegram requires fast response)
  res.sendStatus(200);

  // Process update asynchronously
  const update = req.body;
  handleTelegramUpdate(update, config).catch((err) => {
    console.error('[telegram] Error handling update:', err);
  });
});

export default router;
