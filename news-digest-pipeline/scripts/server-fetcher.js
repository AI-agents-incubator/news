#!/usr/bin/env node

/**
 * Server-side Fetcher for News Digest Pipeline (production, containerised).
 *
 * Same job as scripts/local-fetcher.js — poll the API for articles without
 * content, render each in a real headed Chrome, extract the DOM, PATCH the
 * content back — but built to run UNATTENDED on the VPS instead of the user's
 * Mac. Two problems the Mac path had are gone by construction:
 *
 *   1. FOCUS-STEAL. The Mac fetcher launched a real Chrome; when the mechanism
 *      hiccuped it popped windows and stole focus every few minutes. Here Chrome
 *      runs under Xvfb (a virtual X display) inside a container — there is no
 *      physical screen it *can* grab. The user's Mac is never touched again.
 *
 *   2. CLOUDFLARE FROM A DATACENTRE IP. Perplexity is behind Cloudflare, which
 *      scores the client (IP reputation + TLS/browser fingerprint + behaviour).
 *      A lone datacentre IP scores badly. The container routes Chrome through
 *      Cloudflare WARP (the free consumer VPN): egress gets a "human-reputation"
 *      consumer IP and passes the challenge. Measured 456 KB of real content
 *      with the Cloudflare interstitial absent, from this same VPS. Only Chrome
 *      uses the WARP SOCKS proxy; this Node process reaches the API directly.
 *
 * DIFFERENCES vs local-fetcher.js:
 *   • Config comes from the container ENV (no .env / dotenv).
 *   • This process does NOT launch Chrome. The entrypoint launches a persistent
 *     headed Chrome (under Xvfb, through WARP) on FETCH_CHROME_PORT; we only
 *     connect over CDP. If Chrome is unreachable we exit non-zero so Docker's
 *     restart policy relaunches the whole container (fresh Xvfb+WARP+Chrome).
 *   • Long-lived: runs a cycle, sleeps CHECK_INTERVAL_MS, repeats — instead of
 *     the Mac's one-shot-per-LaunchAgent-tick model.
 *
 * IMPORTANT: Chrome runs HEADED. Headless is blocked by Cloudflare
 * ("Just a moment…"); a real headed Chrome passes. Do NOT add --headless.
 *
 * Requires: Node 20+ started with --experimental-websocket (global WebSocket),
 * cheerio. See production/server-fetcher/ for the image and compose service.
 */

import { load as cheerioLoad } from 'cheerio';
import { validateArticleUrl } from '../src/services/url-validator.js';

const SERVER = process.env.BASE_URL;
const API_KEY = process.env.API_SECRET_KEY;

if (!SERVER || !API_KEY) {
  console.error('Missing BASE_URL or API_SECRET_KEY in environment');
  process.exit(1);
}

if (typeof WebSocket === 'undefined') {
  console.error('Global WebSocket unavailable — run node with --experimental-websocket.');
  process.exit(1);
}

const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}` };

const DEBUG_PORT = parseInt(process.env.FETCH_CHROME_PORT || '9333', 10);
// How long to sleep between full cycles (ms). Mirrors the Mac LaunchAgent cadence.
const CHECK_INTERVAL_MS = parseInt(process.env.FETCH_INTERVAL_MS || '300000', 10);
// How long to wait for the entrypoint-managed Chrome to answer on startup (ms).
const CHROME_WAIT_MS = parseInt(process.env.FETCH_CHROME_WAIT_MS || '60000', 10);

const LOAD_WAIT_MS = 9000;       // Cap on waiting for the load event
const BETWEEN_TABS_MS = 1500;    // Pause between articles
// Perplexity renders the article client-side AFTER load; over the WARP SOCKS
// proxy that hydration can take >10s. Poll until the main content has real text
// (distinguishes a hydrated article from Cloudflare's short interstitial),
// capped so a genuinely empty page still returns.
const HYDRATE_MAX_MS = 18000;
const HYDRATE_MIN_LEN = 1000;

// Same selectors as extension/popup.js and scripts/local-fetcher.js
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
  const [resNew, resError] = await Promise.all([
    fetch(`${SERVER}/api/articles?status=new&limit=50`, { headers: AUTH_HEADERS }),
    fetch(`${SERVER}/api/articles?status=error&limit=50`, { headers: AUTH_HEADERS }),
  ]);
  if (!resNew.ok) throw new Error(`Server returned ${resNew.status}`);
  if (!resError.ok) throw new Error(`Server returned ${resError.status}`);

  const articlesNew = await resNew.json();
  const articlesError = await resError.json();
  const all = [...articlesNew, ...articlesError];

  return all.filter(a => !a.content || a.content.trim().length < 100);
}

async function sendContentToServer(articleId, title, content) {
  const res = await fetch(`${SERVER}/api/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    body: JSON.stringify({ title, content }),
  });
  // 409 is not a transport failure: the server's duplicate guard refused this
  // content because another article already holds it (page substitution). It
  // also records the fetch failure itself, so the caller must NOT report again.
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    return { rejectedDuplicate: true, duplicateOf: body.duplicateOf || 'unknown' };
  }
  if (!res.ok) {
    throw new Error(`PATCH failed (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

/**
 * Report a per-article extraction failure. After the server's attempt cap the
 * article flips to 'unfetchable' and stops being re-selected — this is what
 * breaks the endless every-cycle loop on URLs that never yield content.
 * Best-effort: a failed report just means one more retry next cycle.
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
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// CDP against the entrypoint-managed Chrome
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

/** Wait for the entrypoint-managed Chrome to answer, up to CHROME_WAIT_MS. */
async function waitForChrome() {
  const deadline = Date.now() + CHROME_WAIT_MS;
  while (Date.now() < deadline) {
    if (await chromeAlive()) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Open a raw CDP session to a target's webSocketDebuggerUrl. Returns { send,
 * once, close }. Identical protocol handling to scripts/local-fetcher.js.
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
 * Load a URL in a fresh tab and return the fully rendered outerHTML. Always
 * closes the tab. Throws on protocol failure.
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
    await Promise.race([c.once('Page.loadEventFired'), sleep(LOAD_WAIT_MS)]);

    // Poll for SPA hydration instead of a fixed settle: grab the HTML only once
    // the main content region has real text (> HYDRATE_MIN_LEN), or the cap hits.
    const deadline = Date.now() + HYDRATE_MAX_MS;
    while (Date.now() < deadline) {
      const probe = await c.send('Runtime.evaluate', {
        expression: '((document.querySelector(\'article, [class*="prose"], main\') || document.body).innerText || "").length',
        returnByValue: true,
      });
      const len = (probe.result && probe.result.result && probe.result.result.value) || 0;
      if (len > HYDRATE_MIN_LEN) break;
      await sleep(1500);
    }

    const res = await c.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    // Hard filter against URL↔content mismatch. An unresolvable /page/ slug does
    // NOT 404 — Perplexity's SPA answers 200 and renders the text of ANOTHER,
    // previously loaded article, so we would store someone else's story under
    // our URL and publish it. Length thresholds cannot catch this (observed
    // substitutions run 1000–3200 chars), and killing the service worker plus
    // the HTTP cache does not prevent it either (5 of 6 repeats still swapped).
    //
    // The one clean discriminator we measured is the "related pages" block:
    // a[href*="/page/"] is exactly 0 on all 6 dead slugs and exactly 4 on all
    // 12 distinct live articles sampled across three months — not a single
    // zero on a real page. So 0 links now REJECTS the page instead of merely
    // warning: burning an attempt on a real article is far cheaper than
    // publishing a foreign one under our link.
    const linkRes = await c.send('Runtime.evaluate', {
      expression: 'document.querySelectorAll(\'a[href*="/page/"]\').length',
      returnByValue: true,
    });
    const relatedLinks = (linkRes.result && linkRes.result.result && linkRes.result.result.value) || 0;
    return {
      html: (res.result && res.result.result && res.result.result.value) || '',
      relatedLinks,
    };
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

  $(REMOVE_SELECTORS).remove();

  let title = $('h1').first().text().trim();
  if (!title) {
    title = $('meta[property="og:title"]').attr('content') || '';
  }
  if (!title) {
    title = $('title').text().replace(/\s*[-|].*$/, '').trim();
  }

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

  if (!content || content.length < 200) {
    content = $('body').text().trim();
  }

  content = content.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return { title, content };
}

// ---------------------------------------------------------------------------
// One cycle
// ---------------------------------------------------------------------------

async function runCycle() {
  // Chrome is owned by the entrypoint. If it died, exit non-zero so Docker
  // restarts the container and relaunches Xvfb+WARP+Chrome cleanly.
  if (!(await chromeAlive())) {
    log(`Chrome unreachable on port ${DEBUG_PORT} — exiting for container restart.`);
    process.exit(1);
  }

  let articles;
  try {
    articles = await fetchArticlesWithoutContent();
  } catch (err) {
    log(`Error connecting to server: ${err.message}`);
    return;
  }

  if (articles.length === 0) {
    log('No articles without content.');
    return;
  }

  log(`Found ${articles.length} article(s) without content.`);

  let enriched = 0;
  let failed = 0;

  for (const article of articles) {
    log(`Processing: ${article.url}`);
    try {
      const v = validateArticleUrl(article.url);
      if (!v.ok) {
        log(`  Skipping untrusted URL (${v.error}): ${article.url}`);
        await reportFetchFailure(article.id, `invalid_url: ${v.error}`);
        failed++;
        continue;
      }

      const { html, relatedLinks } = await fetchRenderedHtml(v.href);
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

      if (relatedLinks === 0) {
        log(`  No related-page links — the page looks like the SPA fallback for a dead `
          + `slug (content would belong to another article). Content NOT saved.`);
        await reportFetchFailure(article.id, 'fallback_page: no related-page links');
        failed++;
        continue;
      }

      const sent = await sendContentToServer(article.id, title, content);
      if (sent && sent.rejectedDuplicate) {
        // Server-side second line of defence already recorded the failure for
        // this article; reporting again would double-count the attempt.
        log(`  Server rejected: content duplicates article ${sent.duplicateOf} — `
          + `likely a substituted page. Content NOT saved.`);
        failed++;
        continue;
      }
      log(`  Sent to server: "${title}" (${content.length} chars)`);
      enriched++;

      await sleep(BETWEEN_TABS_MS);
    } catch (err) {
      log(`  Error: ${err.message}`);
      await reportFetchFailure(article.id, `error: ${err.message}`);
      failed++;
    }
  }

  log(`Cycle done. Enriched: ${enriched}, Failed: ${failed}, Total: ${articles.length}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  log(`Server fetcher starting. API: ${SERVER}, Chrome port: ${DEBUG_PORT}, interval: ${CHECK_INTERVAL_MS}ms`);

  if (!(await waitForChrome())) {
    log(`ABORT: entrypoint Chrome never came up on port ${DEBUG_PORT} within ${CHROME_WAIT_MS}ms.`);
    process.exit(1);
  }
  log('Chrome is reachable. Entering fetch loop.');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCycle();
    } catch (err) {
      log(`Cycle error: ${err.message}`);
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
