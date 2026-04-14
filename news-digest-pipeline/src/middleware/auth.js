/**
 * Authentication middleware for API and Dashboard.
 *
 * - API routes: Bearer token or query param ?key= (using API_SECRET_KEY)
 * - Dashboard: HTTP Basic Auth (using DASHBOARD_PASSWORD, separate from API key)
 * - Telegram webhook: exempted (has its own secret-token check)
 *
 * Two separate keys: compromising one doesn't compromise the other.
 */

import { createHash, timingSafeEqual } from 'crypto';

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

export function apiAuth(req, res, next) {
  // Telegram webhook has its own auth via X-Telegram-Bot-Api-Secret-Token
  if (req.path.startsWith('/telegram/') || req.path.startsWith('/api/telegram/')) return next();

  const expectedKey = process.env.API_SECRET_KEY;
  if (!expectedKey) return next(); // dev mode

  // Check Bearer token
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7);
    if (safeCompare(bearer, expectedKey)) return next();
  }

  // Check query param
  if (req.query.key && safeCompare(req.query.key, expectedKey)) return next();

  // Check Basic Auth (dashboard passes Basic Auth to API on same origin)
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const pass = decoded.slice(colonIdx + 1);
        // Accept either API key or dashboard password
        const dashPass = process.env.DASHBOARD_PASSWORD || '';
        if (safeCompare(pass, expectedKey) || (dashPass && safeCompare(pass, dashPass))) return next();
      }
    } catch {
      // malformed — fall through
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

export function dashboardAuth(req, res, next) {
  const expectedPass = process.env.DASHBOARD_PASSWORD || process.env.API_SECRET_KEY;
  if (!expectedPass) return next(); // dev mode

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="News Digest Dashboard"');
    return res.status(401).send('Authentication required');
  }

  try {
    const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      res.setHeader('WWW-Authenticate', 'Basic realm="News Digest Dashboard"');
      return res.status(401).send('Invalid credentials');
    }
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    const expectedUser = process.env.DASHBOARD_USER || 'admin';

    if (!safeCompare(user, expectedUser) || !safeCompare(pass, expectedPass)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="News Digest Dashboard"');
      return res.status(401).send('Invalid credentials');
    }
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="News Digest Dashboard"');
    return res.status(401).send('Invalid credentials');
  }

  next();
}
