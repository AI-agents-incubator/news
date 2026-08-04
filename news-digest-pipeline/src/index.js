import express from 'express';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { initDb, getDb } from './db/index.js';
import { writeAuth } from './middleware/auth.js';
import healthRouter from './routes/health.js';
import articlesRouter from './routes/articles.js';
import digestsRouter from './routes/digests.js';
import telegramRouter from './routes/telegram.js';
import settingsRouter from './routes/settings.js';
import authRouter from './routes/auth.js';
import { loadPro } from './pro-loader.js';
import { startQueueManager } from './services/queue-manager.js';
import { setupTelegramBot } from './services/telegram-bot.js';
import { ensureDigestCardImagesDir } from './services/digest-card-store.js';
import { skipOAuthCallbackLog } from './services/oauth-log-policy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Behind exactly one reverse proxy (Traefik) in production — the domain's DNS
// points straight at the VPS, no Cloudflare in front — so trust a single hop.
// This makes req.ip reflect the real client instead of the proxy, which is what
// per-IP rate limiting keys on.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Baseline security headers on every response. Dependency-free (no Helmet) to
// keep the image and supply chain small. No CSP: the dashboard relies on inline
// scripts, and X-Frame-Options + nosniff already cover the real risks
// (clickjacking, MIME sniffing, referrer/secret leakage).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// Middleware
app.use(express.json({ limit: '5mb' }));
// The Instagram OAuth callback carries a short-lived authorization code in its
// query string. Threads will do the same. Morgan's default `dev` format logs the
// full URL, so skip both endpoints rather than persisting either credential.
app.use(morgan('dev', { skip: skipOAuthCallbackLog }));

// Debug logging — only in development
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.path !== '/health') {
      console.log(`[debug] ${req.method} ${req.path} Content-Type: ${req.headers['content-type']}`);
    }
    next();
  });
}

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests' },
});

const publishLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many publish requests' },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Too many generation requests' },
});

// Brute-force guard for write attempts. Counts only MUTATING requests that FAIL
// (skipSuccessfulRequests decrements the counter on a 2xx), so a bot hammering
// POST/PATCH/DELETE with bad credentials trips 429 BEFORE writeAuth even
// evaluates them, while the legitimate owner's successful writes never accrue.
// Keyed per client IP (relies on the trust-proxy setting above). Complements
// loginLimiter, which only guards /api/auth.
const writeFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()),
  message: { error: 'Слишком много неудачных попыток. Повторите позже.' },
});

// The Telegram webhook is a public POST endpoint (its own secret-token check,
// so it sits outside writeAuth). Keep it behind a rate limiter so it can't be
// flooded by the internet. Generous — real Telegram bursts are small.
const telegramLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests' },
});

// Health endpoint — public, no auth
app.use('/health', healthRouter);

// Dashboard pages — served publicly. Read-only for anonymous visitors; the
// frontend enables editing controls only after a successful login. Writes are
// still enforced server-side by writeAuth below.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // login attempts per IP per 15 min
  message: { error: 'Too many login attempts, try again later' },
  skipSuccessfulRequests: true,
});

app.use(express.static(join(__dirname, 'public')));
// Immutable digest-card JPEGs live in the mounted data volume. They are public
// by design: the future Instagram Graph API must be able to fetch the exact
// reviewed asset over the production HTTPS URL. UUID filenames are never
// overwritten, so long cache headers are safe.
app.use('/digest-card-images', express.static(ensureDigestCardImagesDir(config), {
  maxAge: '365d',
  immutable: true,
}));

// Auth status/login — public (status is read-only; login triggers Basic Auth)
app.use('/api/auth', loginLimiter, authRouter);

// Telegram webhook — mounted before write-auth (has its own secret-token check),
// but behind a rate limiter so the public endpoint can't be flooded.
app.use('/api/telegram', telegramLimiter, telegramRouter);

// Public reads, authenticated writes for all other /api/* routes. The
// brute-force guard runs first so failed write attempts are rate-limited before
// credentials are even checked.
app.use('/api', writeFailLimiter);
app.use('/api', writeAuth, apiLimiter);

// Initialize the database up front: the optional pro cluster runs its schema
// migration inside register() below, so the connection must exist first.
try {
  initDb(config.dbPath);
  console.log(`[init] Database initialized at ${config.dbPath}`);
} catch (err) {
  console.error('[init] Failed to initialize database:', err);
  process.exit(1);
}

// API routes with specific rate limits
app.use('/api/settings', settingsRouter);

// Optional pro cluster (FB-Syndication). Present only in the private build; in
// the public/open-core build loadPro() returns null and the feature stays off
// (its route 404s, its dashboard tab hides itself — see /api/features below).
const pro = await loadPro();
const proCtx = { getDb, config };
const enabledFeatures = pro ? (pro.register(app, proCtx) || pro.features || []) : [];
console.log(
  pro
    ? `[init] Pro features enabled: ${enabledFeatures.join(', ') || '(none)'}`
    : '[init] Pro cluster not present — running open-core build'
);

// Feature discovery — present in BOTH builds. The dashboard fetches this to hide
// UI for features that aren't mounted (e.g. the "Публикация" tab).
app.get('/api/features', (req, res) => {
  res.json({ features: enabledFeatures });
});

app.use('/api/articles', articlesRouter);
app.use('/api/digests/generate', generateLimiter);
app.use('/api/digests/:id/publish', publishLimiter);
app.use('/api/digests', digestsRouter);

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
