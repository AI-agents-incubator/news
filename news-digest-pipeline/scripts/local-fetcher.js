#!/usr/bin/env node

/**
 * Local Mac Fetcher for News Digest Pipeline
 *
 * Checks the server for articles without content, opens each in a DEDICATED
 * Chrome instance, extracts the rendered DOM, and sends the content back.
 *
 * ── Why a dedicated Chrome driven over CDP (not AppleScript) ──────────────────
 * The previous version drove the user's Chrome via AppleScript
 * (`tell application "Google Chrome"`). That is fragile in two ways that caused
 * repeated multi-day outages:
 *   1. AppleScript addresses whatever "Google Chrome" process is registered, so
 *      any OTHER running Chrome (a Playwright/automation instance, the ChatGPT
 *      desktop app, etc.) HIJACKS the target — and those run a profile with
 *      "Allow JavaScript from Apple Events" off → `execute javascript` fails →
 *      0 chars for EVERY article → the fetcher re-opened the same tabs forever.
 *   2. The apple-events toggle is easy to lose and hard to guarantee.
 *
 * This version launches its OWN Chrome with a dedicated profile and a fixed
 * --remote-debugging-port, and drives it over the Chrome DevTools Protocol.
 * It is immune to other Chrome instances (separate user-data-dir) and needs no
 * apple-events toggle. It stays alive between runs (relaunched only if the port
 * is down), so there is no per-cycle window churn.
 *
 * IMPORTANT: the fetch Chrome runs HEADED (offscreen). Headless is blocked by
 * Perplexity's Cloudflare challenge ("Just a moment…"); a real headed Chrome
 * passes it. Do NOT switch this to --headless.
 *
 * Non-intrusive: the dedicated window is positioned far offscreen and the app is
 * never activated, so the user's own Chrome, windows, and focus are untouched.
 *
 * Requires: macOS + Google Chrome, Node 20+ started with --experimental-websocket
 * (global WebSocket; set via NODE_OPTIONS in the LaunchAgent), cheerio.
 */

import { spawn } from 'child_process';
import { load as cheerioLoad } from 'cheerio';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { validateArticleUrl } from '../src/services/url-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(__dirname, '..', '.env') });

const SERVER = process.env.BASE_URL;
const API_KEY = process.env.API_SECRET_KEY;

if (!SERVER || !API_KEY) {
  console.error('Missing BASE_URL or API_SECRET_KEY in .env');
  process.exit(1);
}

if (typeof WebSocket === 'undefined') {
  console.error('Global WebSocket unavailable — run node with --experimental-websocket (NODE_OPTIONS).');
  process.exit(1);
}

const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}` };

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = parseInt(process.env.FETCH_CHROME_PORT || '9333', 10);
// Dedicated, persistent profile — isolated from the user's Chrome so a second
// instance can coexist and other Chromes never interfere.
const PROFILE_DIR = join(homedir(), '.news-fetch-chrome');

const LOAD_WAIT_MS = 9000;       // Wait for page (incl. Cloudflare JS) to settle
const BETWEEN_TABS_MS = 1500;    // Pause between articles

// Same selectors as extension/popup.js and article-fetcher.js
const CONTENT_SELECTORS = [
  'article',
  '[class*="prose"]',
  '.scrollbar-subtle',
  '.markdown',
  'main',
];

const REMOVE_SELECTORS = 'script, style, nav, header, footer, [class*="sideBarWidth"], .sidebar, aside, [role="navigation"], [role="banner"]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Server API
// ---------------------------------------------------------------------------

async function fetchArticlesWithoutContent() {
  // Fetch both 'new' and 'error' articles — both may lack content
  const [resNew, resError] = await Promise.all([
    fetch(`${SERVER}/api/articles?status=new&limit=50`, { headers: AUTH_HEADERS }),
    fetch(`${SERVER}/api/articles?status=error&limit=50`, { headers: AUTH_HEADERS }),
  ]);
  if (!resNew.ok) throw new Error(`Server returned ${resNew.status}`);
  if (!resError.ok) throw new Error(`Server returned ${resError.status}`);

  const articlesNew = await resNew.json();
  const articlesError = await resError.json();
  const all = [...articlesNew, ...articlesError];

  // Filter: content is null, empty, or very short
  return all.filter(a => !a.content || a.content.trim().length < 100);
}

async function sendContentToServer(articleId, title, content) {
  const res = await fetch(`${SERVER}/api/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) {
    throw new Error(`PATCH failed (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

/**
 * Report a per-article extraction failure to the server. After the server's
 * configured attempt cap the article is flipped to 'unfetchable' and this
 * fetcher stops re-selecting it — that is what breaks the endless every-cycle
 * loop on URLs that never yield content. Best-effort: a failed report just means
 * the article is retried next cycle (no worse than before).
 */
async function reportFetchFailure(articleId, reason) {
  try {
    const res = await fetch(`${SERVER}/api/articles/${articleId}/fetch-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) {
      const r = await res.json();
      if (r && r.capped) {
        log(`  Gave up after ${r.attempts} attempts → marked unfetchable (will not retry).`);
      }
    }
  } catch {
    // best-effort — do not let a reporting failure abort the run
  }
}

// ---------------------------------------------------------------------------
// Dedicated Chrome + Chrome DevTools Protocol
// ---------------------------------------------------------------------------

async function chromeAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the dedicated fetch Chrome is up on DEBUG_PORT. Reused across runs;
 * launched (headed, far offscreen, background) only if the port is down.
 * Returns true once the debug endpoint answers.
 */
async function ensureChrome() {
  if (await chromeAlive()) return true;

  log('Launching dedicated fetch Chrome (headed, offscreen)…');
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--window-position=-3000,-3000',
    '--window-size=1200,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await chromeAlive()) return true;
  }
  return false;
}

/**
 * Open a raw CDP session to a target's webSocketDebuggerUrl. Returns { send,
 * once, close } — send(method, params) resolves with the command result; once
 * (method) resolves on the next matching protocol event.
 */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let idc = 0;
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 8000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send: (method, params = {}) => new Promise((res) => {
          const id = ++idc;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        }),
        once: (method) => new Promise((res) => { listeners.set(method, res); }),
        close: () => { try { ws.close(); } catch { /* noop */ } },
      });
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      } else if (m.method && listeners.has(m.method)) {
        const cb = listeners.get(m.method);
        listeners.delete(m.method);
        cb(m);
      }
    };
  });
}

/**
 * Load a URL in a fresh tab of the dedicated Chrome and return the fully
 * rendered outerHTML. Always closes the tab. Throws on protocol failure.
 */
async function fetchRenderedHtml(url) {
  const tabRes = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT', signal: AbortSignal.timeout(5000) },
  );
  if (!tabRes.ok) throw new Error(`open tab failed (${tabRes.status})`);
  const tab = await tabRes.json();

  const c = await cdpConnect(tab.webSocketDebuggerUrl);
  try {
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    // Race the load event against a fixed budget: some pages fire load before we
    // attach (tab opened already navigated), so the timeout is the real backstop.
    await Promise.race([c.once('Page.loadEventFired'), sleep(LOAD_WAIT_MS)]);
    await sleep(1200); // settle SPA/Cloudflare hydration
    const res = await c.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    return (res.result && res.result.result && res.result.result.value) || '';
  } finally {
    c.close();
    fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${tab.id}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Content Extraction (mirrors extension logic)
// ---------------------------------------------------------------------------

function extractFromHtml(html) {
  const $ = cheerioLoad(html);

  // Remove unwanted elements
  $(REMOVE_SELECTORS).remove();

  // Extract title
  let title = $('h1').first().text().trim();
  if (!title) {
    title = $('meta[property="og:title"]').attr('content') || '';
  }
  if (!title) {
    title = $('title').text().replace(/\s*[-|].*$/, '').trim();
  }

  // Extract content using the same selectors as the extension
  let content = '';
  for (const selector of CONTENT_SELECTORS) {
    const el = $(selector).first();
    if (el.length) {
      const text = el.text().trim();
      if (text.length > 100) {
        content = text;
        break;
      }
    }
  }

  // Fallback: body text
  if (!content || content.length < 200) {
    content = $('body').text().trim();
  }

  // Clean up whitespace
  content = content.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return { title, content };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('Checking server for articles without content...');

  let articles;
  try {
    articles = await fetchArticlesWithoutContent();
  } catch (err) {
    log(`Error connecting to server: ${err.message}`);
    process.exit(1);
  }

  if (articles.length === 0) {
    log('No articles without content. Done.');
    process.exit(0);
  }

  log(`Found ${articles.length} article(s) without content.`);

  // Systemic gate: if the dedicated fetch Chrome can't be reached, abort the
  // whole run WITHOUT touching any article (no false 'unfetchable' marks). The
  // articles stay queued and fetch normally once Chrome is reachable again.
  if (!(await ensureChrome())) {
    log(`ABORT: dedicated fetch Chrome not reachable on port ${DEBUG_PORT}. Articles left untouched.`);
    process.exit(0);
  }

  let enriched = 0;
  let failed = 0;

  for (const article of articles) {
    log(`Processing: ${article.url}`);

    try {
      // Validate against the shared contract (HTTPS + perplexity.ai + no control
      // chars) before the URL is used.
      const v = validateArticleUrl(article.url);
      if (!v.ok) {
        log(`  Skipping untrusted URL (${v.error}): ${article.url}`);
        await reportFetchFailure(article.id, `invalid_url: ${v.error}`);
        failed++;
        continue;
      }

      const html = await fetchRenderedHtml(v.href);
      if (!html || html.length < 200) {
        log(`  Got empty or too short page source (${html?.length || 0} chars), skipping.`);
        await reportFetchFailure(article.id, `empty_source: ${html?.length || 0} chars`);
        failed++;
        continue;
      }

      const { title, content } = extractFromHtml(html);

      if (!content || content.length < 100) {
        log(`  Content too short (${content?.length || 0} chars), skipping.`);
        await reportFetchFailure(article.id, `content_too_short: ${content?.length || 0} chars`);
        failed++;
        continue;
      }

      await sendContentToServer(article.id, title, content);
      log(`  Sent to server: "${title}" (${content.length} chars)`);
      enriched++;

      await sleep(BETWEEN_TABS_MS);

    } catch (err) {
      log(`  Error: ${err.message}`);
      await reportFetchFailure(article.id, `error: ${err.message}`);
      failed++;
    }
  }

  log(`Done. Enriched: ${enriched}, Failed: ${failed}, Total: ${articles.length}`);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
