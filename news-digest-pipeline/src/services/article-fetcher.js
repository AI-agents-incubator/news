import * as cheerio from 'cheerio';
import { chromium } from 'playwright-core';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Stealth JS to inject into every page before any other scripts run.
 * Patches the most common bot-detection vectors.
 */
const STEALTH_JS = `
  // 1. Remove navigator.webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 2. Override navigator.plugins to look like a real browser
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
  });

  // 3. Override navigator.languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'ru'],
  });

  // 4. Fix chrome.runtime to look present (Chromium detection)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };

  // 5. Override permissions query to deny 'notifications' (headless tells)
  const origQuery = window.Permissions.prototype.query;
  window.Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return origQuery.call(this, params);
  };

  // 6. Fake WebGL renderer (avoid SwiftShader detection)
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 0x9245) return 'Google Inc. (Apple)';
    // UNMASKED_RENDERER_WEBGL
    if (param === 0x9246) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)';
    return getParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 0x9245) return 'Google Inc. (Apple)';
      if (param === 0x9246) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)';
      return getParameter2.call(this, param);
    };
  }
`;

const CONTENT_SELECTORS = [
  'article',
  '[class*="prose"]',
  '.scrollbar-subtle',
  '.markdown',
  'main',
];

const REMOVE_SELECTORS = 'script, style, nav, header, footer, [class*="sideBarWidth"], .sidebar, aside, [role="navigation"], [role="banner"]';

/**
 * Try fetching article content with cheerio (fast, lightweight).
 * Returns { title, content } or throws on failure.
 */
async function fetchWithCheerio(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const html = await response.text();
  return extractFromHtml(html);
}

/**
 * Extract title and content from raw HTML using cheerio.
 */
function extractFromHtml(html) {
  const $ = cheerio.load(html);

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

  // Extract content using selectors from the extension
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

/**
 * Fallback: fetch article content using Playwright headless browser.
 * Used when cheerio fetch gets 403 or content is too short.
 */
async function fetchWithPlaywright(url) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const browser = await chromium.launch({
    headless: false,  // We use --headless=new via args (bypasses bot detection better than old headless)
    executablePath,
    args: [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--start-maximized',
      '--lang=en-US,en',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      deviceScaleFactor: 1,
      hasTouch: false,
      javaScriptEnabled: true,
    });

    // Inject stealth patches before any page scripts run
    await context.addInitScript(STEALTH_JS);

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for actual content to appear instead of a fixed timeout.
    // Try content selectors first, then fall back to a short delay.
    const contentSelector = CONTENT_SELECTORS.map(s => s).join(', ');
    try {
      await page.waitForSelector(contentSelector, { timeout: 15000 });
      // Give a bit more time for SPA hydration
      await page.waitForTimeout(2000);
    } catch {
      // Selector not found — page may use unusual markup; wait longer
      console.log(`[article-fetcher] Content selector not found, waiting extra time...`);
      await page.waitForTimeout(8000);
    }

    const html = await page.content();
    const result = extractFromHtml(html);

    return result;
  } finally {
    await browser.close();
  }
}

export async function fetchArticleContent(url) {
  // Try cheerio first (fast, lightweight)
  try {
    const result = await fetchWithCheerio(url);
    if (result.content && result.content.length >= 200) {
      return result;
    }
    // Content too short — fall through to Playwright
    console.log(`[article-fetcher] Cheerio got short content (${result.content?.length || 0} chars) for ${url}, trying Playwright...`);
  } catch (err) {
    const is403 = err.message.includes('HTTP 403');
    if (is403) {
      console.log(`[article-fetcher] Got 403 for ${url}, trying Playwright...`);
    } else {
      console.log(`[article-fetcher] Cheerio failed for ${url}: ${err.message}, trying Playwright...`);
    }
  }

  // Fallback to Playwright (headless browser)
  try {
    const result = await fetchWithPlaywright(url);
    if (!result.content || result.content.length < 200) {
      throw new Error(`Content too short (${result.content?.length || 0} chars) for ${url}`);
    }
    return result;
  } catch (err) {
    throw new Error(`Both cheerio and Playwright failed for ${url}: ${err.message}`);
  }
}
