#!/usr/bin/env node

/**
 * Facebook Personal Profile Publisher
 *
 * Launches a SEPARATE Patchright Chromium (not your Chrome!)
 * with a persistent profile that remembers Facebook login.
 * Your Chrome stays untouched — you can keep working.
 *
 * First run: will open Facebook login page — log in manually.
 * Subsequent runs: session is remembered, posts automatically.
 *
 * Usage:
 *   node scripts/fb-publish.js latest
 *   node scripts/fb-publish.js <digest-id>
 *   node scripts/fb-publish.js --login     # just open browser to log in
 */

import { chromium } from 'patchright';
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = 'https://YOUR_DOMAIN';
const PROFILE_DIR = join(__dirname, '..', '.fb-profile');

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function notify(title, message) {
  exec(`osascript -e 'display notification "${message}" with title "${title}" sound name "Ping"'`);
}

// --- API ---

async function getDigestContent(digestId) {
  const url = digestId === 'latest'
    ? `${SERVER}/api/digests/latest/text`
    : `${SERVER}/api/digests/${digestId}/text`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to get digest: ${res.status}`);
  return await res.text();
}

// --- Main flow ---

async function publishToFacebook(text, loginOnly = false) {
  log('Launching separate Chromium browser...');
  notify('Facebook', 'Открываю браузер для публикации...');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1200, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // Navigate to Facebook
    log('Opening Facebook...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    // Check if logged in
    const isLoggedIn = await page.locator('[aria-label="Create a post"], [aria-label="Создать публикацию"], span:has-text("What\'s on your mind")').first().isVisible({ timeout: 5000 }).catch(() => false);

    if (!isLoggedIn) {
      log('Not logged in. Please log in manually in the browser window.');
      notify('Facebook', 'Залогиньтесь в браузере, затем запустите скрипт снова.');
      // Wait for user to log in (up to 5 minutes)
      if (loginOnly) {
        log('Waiting for login... Close the browser when done.');
        await page.waitForSelector('[aria-label="Create a post"], [aria-label="Создать публикацию"]', { timeout: 300000 }).catch(() => {});
        log('Login session saved. You can now run the script to publish.');
        await context.close();
        return;
      }
      throw new Error('Not logged in. Run with --login first.');
    }

    if (loginOnly) {
      log('Already logged in! Session is saved. You can close the browser.');
      await sleep(3000);
      await context.close();
      return;
    }

    log('Logged in. Starting publish flow...');

    // Scroll feed (human behavior)
    log('Scrolling feed...');
    for (let i = 0; i < rand(2, 4); i++) {
      await page.mouse.wheel(0, rand(200, 400));
      await sleep(rand(800, 1500));
    }
    await sleep(rand(1000, 2000));
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(rand(1500, 2500));

    // Click "What's on your mind"
    log('Opening post creation...');
    const createBtn = page.locator('span:has-text("What\'s on your mind"), span:has-text("О чём вы думаете"), [aria-label="Create a post"], [aria-label="Создать публикацию"]').first();
    await createBtn.click();
    await sleep(rand(3000, 4000));

    // Find and click textbox
    log('Focusing text editor...');
    const textbox = page.locator('[role="textbox"][contenteditable="true"]').first();
    await textbox.waitFor({ state: 'visible', timeout: 10000 });
    await textbox.click();
    await sleep(rand(500, 1000));

    // Insert text
    log(`Inserting text (${text.length} chars)...`);
    await page.keyboard.insertText(text);
    await sleep(rand(3000, 6000));

    // Verify text inserted
    const insertedLen = await textbox.innerText().then(t => t.trim().length).catch(() => 0);
    log(`Text in editor: ${insertedLen} chars`);
    if (insertedLen < 10) throw new Error('Text insertion failed');

    // Remove link preview snippets
    log('Removing link previews...');
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(2000);

      const removeBtn = page.locator('[aria-label="Remove link preview from your post"], [aria-label="Удалить превью ссылки из публикации"]').first();
      const hasPreview = await removeBtn.isVisible({ timeout: 1000 }).catch(() => false);

      if (!hasPreview) {
        log('No more link previews.');
        break;
      }

      log(`Removing preview #${attempt + 1}...`);
      await removeBtn.click();
      await sleep(1500);
    }

    // Pause — simulate review
    log('Reviewing post...');
    await sleep(rand(3000, 6000));

    // Close any hashtag/mention dropdowns that might cover buttons
    await page.keyboard.press('Escape');
    await sleep(500);

    // Click somewhere neutral to dismiss popups (click on the dialog title area)
    const dialogTitle = page.locator('text=Create post').first();
    if (await dialogTitle.isVisible().catch(() => false)) {
      await dialogTitle.click();
      await sleep(500);
    }

    // Screenshot before publishing
    await page.screenshot({ path: '/tmp/fb-before-post.png' });

    // Click Next (profile pages have 2-step flow)
    log('Clicking Next...');
    const nextBtn = page.locator('[aria-label="Next"]').first();
    const hasNext = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasNext) {
      const isDisabled = await nextBtn.getAttribute('aria-disabled');
      if (isDisabled === 'true') throw new Error('Next button is disabled — text may not have been accepted');
      await nextBtn.click({ force: true });
      await sleep(rand(2000, 3000));

      // Click Post
      log('Clicking Post...');
      const postBtn = page.locator('[aria-label="Post"], [aria-label="Опубликовать"]').first();
      await postBtn.waitFor({ state: 'visible', timeout: 5000 });
      const postDisabled = await postBtn.getAttribute('aria-disabled');
      if (postDisabled === 'true') throw new Error('Post button is disabled');
      await postBtn.click();
    } else {
      // Single-step flow — just Post
      const postBtn = page.locator('[aria-label="Post"], [aria-label="Опубликовать"]').first();
      await postBtn.waitFor({ state: 'visible', timeout: 5000 });
      await postBtn.click();
    }

    await sleep(rand(3000, 5000));
    log('Published to Facebook personal profile!');
    notify('Опубликовано', 'Пост опубликован в Facebook.');

  } catch (err) {
    log(`Error: ${err.message}`);
    await page.screenshot({ path: '/tmp/fb-publish-error.png' });
    log('Screenshot saved to /tmp/fb-publish-error.png');
    throw err;
  } finally {
    await context.close();
  }
}

// --- Entry point ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--login')) {
    log('Login mode — opening browser for Facebook login...');
    await publishToFacebook('', true);
    return;
  }

  if (!args[0]) {
    console.error('Usage:');
    console.error('  node scripts/fb-publish.js --login        # first time: log in');
    console.error('  node scripts/fb-publish.js latest         # publish latest digest');
    console.error('  node scripts/fb-publish.js <digest-id>    # publish specific digest');
    process.exit(1);
  }

  log(`Fetching digest: ${args[0]}`);
  const text = await getDigestContent(args[0]);

  if (!text || text.length < 10) {
    console.error('Content is empty or too short');
    process.exit(1);
  }

  log(`Content ready: ${text.length} chars`);
  await publishToFacebook(text);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  notify('Ошибка', 'Публикация в Facebook не удалась');
  process.exit(1);
});
