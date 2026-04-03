#!/usr/bin/env node

/**
 * Local Mac Fetcher for News Digest Pipeline
 *
 * Checks server for articles without content, opens them in Chrome,
 * extracts content via AppleScript, sends back to server.
 *
 * No special Chrome flags needed — uses AppleScript to interact with
 * the real Chrome browser, which bypasses Perplexity's bot detection.
 *
 * Usage:
 *   node scripts/local-fetcher.js
 *
 * Requirements:
 *   - macOS with Google Chrome installed
 *   - Node.js 20+ (for native fetch and WebSocket)
 *   - cheerio package (already in project dependencies)
 */

import { execSync } from 'child_process';
import { load as cheerioLoad } from 'cheerio';

const SERVER = 'https://news.questtales.com';
const LOAD_WAIT_MS = 8000;       // Wait for page to load
const BETWEEN_TABS_MS = 2000;    // Pause between processing tabs

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

/**
 * Run AppleScript and return stdout. Returns null on error.
 */
function runAppleScript(script) {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch (err) {
    return null;
  }
}

/**
 * Run multi-line AppleScript via heredoc.
 */
function runAppleScriptMulti(script) {
  try {
    return execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      encoding: 'utf-8',
      timeout: 30000,
      shell: '/bin/bash',
    }).trim();
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server API
// ---------------------------------------------------------------------------

async function fetchArticlesWithoutContent() {
  const res = await fetch(`${SERVER}/api/articles?status=new&limit=50`);
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}: ${await res.text()}`);
  }
  const articles = await res.json();
  // Filter: content is null, empty, or very short
  return articles.filter(a => !a.content || a.content.trim().length < 100);
}

async function sendContentToServer(articleId, title, content) {
  const res = await fetch(`${SERVER}/api/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) {
    throw new Error(`PATCH failed (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Chrome via AppleScript
// ---------------------------------------------------------------------------

function isChromeRunning() {
  const result = runAppleScript(
    'tell application "System Events" to (name of processes) contains "Google Chrome"'
  );
  return result === 'true';
}

/**
 * Open a URL in a new Chrome tab and return the tab index and window id.
 */
function openUrlInChrome(url) {
  const script = `
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then
    make new window
  end if
  tell window 1
    set newTab to make new tab with properties {URL:"${url}"}
    return (active tab index of window 1) as text
  end tell
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Get the page source of the active tab in Chrome.
 */
function getActiveTabSource() {
  const script = `
tell application "Google Chrome"
  tell active tab of window 1
    set pageSource to execute javascript "document.documentElement.outerHTML"
    return pageSource
  end tell
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Get the URL of the active tab.
 */
function getActiveTabUrl() {
  const script = `
tell application "Google Chrome"
  return URL of active tab of window 1
end tell`;
  return runAppleScriptMulti(script);
}

/**
 * Close the active tab in Chrome.
 */
function closeActiveTab() {
  const script = `
tell application "Google Chrome"
  tell active tab of window 1
    close
  end tell
end tell`;
  runAppleScriptMulti(script);
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

  // Check Chrome is running
  if (!isChromeRunning()) {
    log('Google Chrome is not running. Starting it...');
    execSync('open -a "Google Chrome"');
    await sleep(3000);
  }

  let enriched = 0;
  let failed = 0;

  for (const article of articles) {
    log(`Processing: ${article.url}`);

    try {
      // Open URL in a new tab
      openUrlInChrome(article.url);

      // Wait for page to load
      await sleep(LOAD_WAIT_MS);

      // Verify we're on the right page
      const currentUrl = getActiveTabUrl();
      if (!currentUrl) {
        log(`  Could not get active tab URL, skipping.`);
        failed++;
        continue;
      }

      // Get page source
      const html = getActiveTabSource();
      if (!html || html.length < 200) {
        log(`  Got empty or too short page source (${html?.length || 0} chars), skipping.`);
        closeActiveTab();
        failed++;
        continue;
      }

      // Extract content
      const { title, content } = extractFromHtml(html);

      if (!content || content.length < 100) {
        log(`  Content too short (${content?.length || 0} chars), skipping.`);
        closeActiveTab();
        failed++;
        continue;
      }

      // Send back to server
      await sendContentToServer(article.id, title, content);
      log(`  Sent to server: "${title}" (${content.length} chars)`);
      enriched++;

      // Close the tab
      closeActiveTab();

      // Small pause between tabs
      await sleep(BETWEEN_TABS_MS);

    } catch (err) {
      log(`  Error: ${err.message}`);
      // Try to close tab on error
      try { closeActiveTab(); } catch {}
      failed++;
    }
  }

  log(`Done. Enriched: ${enriched}, Failed: ${failed}, Total: ${articles.length}`);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
