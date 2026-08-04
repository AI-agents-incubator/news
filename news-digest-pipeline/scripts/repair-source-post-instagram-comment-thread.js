#!/usr/bin/env node

// Operator-only CLI for a single already-published source post. It has no
// media-publish path. `preflight` reads Meta and freezes evidence; `repair`
// requires an existing preflight plus an exact confirmation phrase.

import config from '../src/config.js';
import { initDb, getDb } from '../src/db/index.js';
import { migrateSourcePosts } from '../src/pro/db/source-posts.js';
import {
  preflightSourcePostInstagramCommentThreadRepair,
  repairSourcePostInstagramCommentThread,
} from '../src/pro/services/source-post-instagram-comment-repair.js';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || '' : '';
};
const postId = valueAfter('--post-id');
const command = valueAfter('--command');
const confirm = valueAfter('--confirm');

if (!postId || !['preflight', 'repair'].includes(command)
  || (command === 'repair' && confirm !== 'REPAIR_SOURCE_POST_COMMENT_THREAD')) {
  console.error('Usage: node scripts/repair-source-post-instagram-comment-thread.js --post-id <uuid> --command preflight');
  console.error('   or: node scripts/repair-source-post-instagram-comment-thread.js --post-id <uuid> --command repair --confirm REPAIR_SOURCE_POST_COMMENT_THREAD');
  process.exit(2);
}

initDb(config.dbPath);
const db = getDb();
migrateSourcePosts(db);
const result = command === 'preflight'
  ? await preflightSourcePostInstagramCommentThreadRepair(db, config, postId)
  : await repairSourcePostInstagramCommentThread(db, config, postId);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'completed' || result.status === 'ready' ? 0 : 1);
