#!/usr/bin/env node

/**
 * Facebook Profile Publisher Watcher
 *
 * Runs on Mac. Polls the server for digests that were published
 * (to Telegram + Page) but not yet posted to personal profile.
 * When found, waits 2-3 minutes, then publishes via Patchright.
 *
 * Designed to run via launchd (macOS cron) every 5 minutes,
 * or manually after clicking "Publish" on the dashboard.
 *
 * Usage:
 *   node scripts/fb-profile-watcher.js           # check and publish if needed
 *   node scripts/fb-profile-watcher.js --force    # publish latest regardless
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = 'https://news.questtales.com';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  // Check for digests that are published (to TG/Page) but not yet posted to profile
  const res = await fetch(`${SERVER}/api/digests`);
  const digests = await res.json();

  // Find digests with status 'published' that have telegram_message_id
  // but haven't been posted to profile yet (we'll track this with a local file)
  const publishedDigests = digests.filter(d =>
    d.status === 'published' &&
    d.telegram_message_id &&
    d.content
  );

  if (publishedDigests.length === 0 && !force) {
    log('No published digests to post to profile.');
    return;
  }

  // Check which ones we already posted to profile
  const postedFile = join(__dirname, '..', '.fb-profile-posted.json');
  let posted = {};
  try {
    const raw = (await import('fs')).readFileSync(postedFile, 'utf-8');
    posted = JSON.parse(raw);
  } catch {}

  const toPost = force
    ? [publishedDigests[0] || digests[0]]
    : publishedDigests.filter(d => !posted[d.id]);

  if (toPost.length === 0) {
    log('All published digests already posted to profile.');
    return;
  }

  for (const digest of toPost) {
    log(`Publishing digest ${digest.id} to Facebook profile...`);
    log(`Digest: ${digest.articles_count} articles, ${digest.content.length} chars`);

    try {
      // Run fb-publish.js
      const result = execSync(
        `node ${join(__dirname, 'fb-publish.js')} ${digest.id}`,
        { encoding: 'utf-8', timeout: 180000, cwd: join(__dirname, '..') }
      );
      console.log(result);

      // Mark as posted
      posted[digest.id] = new Date().toISOString();
      (await import('fs')).writeFileSync(postedFile, JSON.stringify(posted, null, 2));

      log(`Done. Waiting before next...`);
      await sleep(60000); // 1 min between posts
    } catch (err) {
      log(`Error publishing ${digest.id}: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
