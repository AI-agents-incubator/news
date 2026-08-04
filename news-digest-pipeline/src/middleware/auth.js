/**
 * Authentication middleware — public reads, authenticated writes.
 *
 * Model:
 *   - Static pages and all GET/HEAD/OPTIONS API calls are PUBLIC (read-only).
 *   - Mutating API calls (POST/PATCH/DELETE) require credentials.
 *   - Telegram webhook is exempt (has its own secret-token check).
 *
 * Credentials (any one):
 *   - Bearer token using API_SECRET_KEY (used by local-fetcher, API clients)
 *   - HTTP Basic Auth using DASHBOARD_PASSWORD or API_SECRET_KEY (dashboard login)
 *
 * Enforcement is production-only. Locally (NODE_ENV !== 'production') everything
 * is open (full access) so development has no friction.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Hash both to constant length to avoid length-based timing leak
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Whether write-auth is turned OFF. Fail-CLOSED: auth is disabled only when
 * NODE_ENV is an explicit development value ('development' or 'test'). Any other
 * value — 'production', unset, or a typo like 'Production'/'prod' — leaves auth
 * ENABLED, so a misconfigured deployment never silently opens the whole API to
 * the public. (The previous `!== 'production'` check failed OPEN: any typo in
 * NODE_ENV disabled auth entirely.)
 */
function authDisabled() {
  const env = (process.env.NODE_ENV || '').toLowerCase();
  return env === 'development' || env === 'test';
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard session cookie.
//
// Basic Auth alone is unreliable for the dashboard: the browser scopes cached
// credentials to the "protection space" of the URL that issued the 401
// (/api/auth/*), so it sends them to /api/auth/status but NOT to /api/settings,
// which lives on a different path branch. Result: status says "authenticated"
// yet writes get 401. To decouple from that, /api/auth/login sets a signed,
// HttpOnly session cookie scoped to Path=/ — the browser then sends it on every
// same-origin request, so writes authenticate consistently everywhere.
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_COOKIE = 'dash_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sessionSecret() {
  return process.env.API_SECRET_KEY || process.env.DASHBOARD_PASSWORD || '';
}

function signSession(exp) {
  return createHmac('sha256', sessionSecret()).update(String(exp)).digest('hex');
}

/** Set-Cookie value that authenticates a dashboard browser session. */
export function buildSessionCookie() {
  const exp = Date.now() + SESSION_TTL_MS;
  const parts = [
    `${SESSION_COOKIE}=${exp}.${signSession(exp)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

/** Set-Cookie value that clears the dashboard session (logout). */
export function clearSessionCookie() {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

/** True when the request carries a valid, unexpired dashboard session cookie. */
function hasValidSession(req) {
  const secret = sessionSecret();
  if (!secret) return false;
  const cookieHeader = req.headers.cookie || '';
  const m = cookieHeader.match(/(?:^|;\s*)dash_session=([^;]+)/);
  if (!m) return false;
  const raw = decodeURIComponent(m[1]);
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return false;
  const exp = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  return safeCompare(sig, signSession(exp));
}

/**
 * Non-throwing credential check. Returns true if the request carried valid
 * credentials via Bearer token or Basic Auth (API key or dashboard password).
 * Does not send any response.
 */
function hasValidCreds(req) {
  // Dashboard session cookie (set at login) — the primary path for browser
  // writes. Checked first so it works regardless of Basic Auth path scoping.
  if (hasValidSession(req)) return true;

  const expectedKey = process.env.API_SECRET_KEY || '';
  const dashPass = process.env.DASHBOARD_PASSWORD || '';
  const authHeader = req.headers.authorization || '';

  if (expectedKey) {
    if (authHeader.startsWith('Bearer ') && safeCompare(authHeader.slice(7), expectedKey)) return true;
  }

  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const pass = decoded.slice(colonIdx + 1);
        if (expectedKey && safeCompare(pass, expectedKey)) return true;
        if (dashPass && safeCompare(pass, dashPass)) return true;
      }
    } catch {
      // malformed — treat as no creds
    }
  }

  return false;
}

/**
 * Is this caller allowed to perform writes? True in dev (open), or when valid
 * credentials are present. Used by the /api/auth/status endpoint and by
 * writeAuth. Never sends a response.
 */
export function isAuthenticated(req) {
  return authDisabled() || hasValidCreds(req);
}

/**
 * Whether THIS BROWSER holds an authenticated dashboard session (the session
 * cookie). Deliberately ignores cached Basic Auth: the browser sends Basic to
 * /api/auth/* but NOT to /api/settings (different path branch), so trusting it
 * would show "authorized" in the header while writes still 401 — and would make
 * logout impossible (Basic lingers until the tab closes). Basing the status
 * endpoint on the cookie keeps the header, the writes, and logout consistent.
 */
export function isBrowserAuthenticated(req) {
  return authDisabled() || hasValidSession(req);
}

/**
 * Whether write-auth is enforced at all. False in dev (everything open), true
 * in production. The frontend uses this to decide whether to show a login CTA.
 */
export function authRequired() {
  return !authDisabled();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_SIGNED_CALLBACKS = new Set([
  '/oauth/threads/uninstall',
  '/oauth/threads/delete',
  '/api/oauth/threads/uninstall',
  '/api/oauth/threads/delete',
]);

/**
 * Public reads, authenticated writes. Safe methods (GET/HEAD/OPTIONS) always
 * pass. Mutating methods require valid credentials, except when auth is
 * disabled (dev) or for the Telegram webhook (its own secret-token check).
 */
export function writeAuth(req, res, next) {
  if (req.path.startsWith('/telegram/') || req.path.startsWith('/api/telegram/')) return next();
  if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
  if (req.method.toUpperCase() === 'POST' && PUBLIC_SIGNED_CALLBACKS.has(req.path)) return next();
  if (authDisabled()) return next();
  if (hasValidCreds(req)) return next();
  return res.status(401).json({ error: 'Unauthorized — требуется авторизация для изменений' });
}

/**
 * Auth required for every method, including reads.
 *
 * The public dashboard deliberately exposes selected core read models through
 * `writeAuth`. Operator-only modules such as Facebook moderation handle
 * private prompts and enforcement state, so mounting this middleware there
 * keeps their GET endpoints private without changing the public
 * articles/digests contract.
 */
export function operatorAuth(req, res, next) {
  if (authDisabled()) return next();
  if (hasValidCreds(req)) return next();
  return res.status(401).json({ error: 'Unauthorized — требуется авторизация' });
}
