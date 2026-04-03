import express from 'express';
import morgan from 'morgan';
import config from './config.js';
import { initDb } from './db/index.js';
import healthRouter from './routes/health.js';
import articlesRouter from './routes/articles.js';
import digestsRouter from './routes/digests.js';
import telegramRouter from './routes/telegram.js';
import { startQueueManager } from './services/queue-manager.js';
import { setupTelegramBot } from './services/telegram-bot.js';

const app = express();

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));

// Debug: log all incoming requests
app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`[debug] ${req.method} ${req.path} Content-Type: ${req.headers['content-type']} Body:`, typeof req.body === 'string' ? req.body.slice(0, 200) : JSON.stringify(req.body)?.slice(0, 200));
  }
  next();
});

// Routes
app.use('/health', healthRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/digests', digestsRouter);
app.use('/api/telegram', telegramRouter);

// Initialize
try {
  initDb(config.dbPath);
  console.log(`[init] Database initialized at ${config.dbPath}`);
} catch (err) {
  console.error('[init] Failed to initialize database:', err);
  process.exit(1);
}

// Start queue manager
const queueInterval = startQueueManager(config);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Stopping...');
  clearInterval(queueInterval);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Stopping...');
  clearInterval(queueInterval);
  process.exit(0);
});

// Start server
app.listen(config.port, () => {
  console.log(`[server] News Digest Pipeline running on port ${config.port}`);
  console.log(`[server] Environment: ${config.nodeEnv}`);

  // Register Telegram webhook after server is listening
  setupTelegramBot(config).catch((err) => {
    console.error('[init] Failed to setup Telegram bot:', err.message);
  });
});
