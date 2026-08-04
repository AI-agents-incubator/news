// Persistent, public delivery assets for digest-level Instagram cards.
// The directory lives beside the SQLite database, so Docker's existing data
// volume keeps both the receipt and its immutable JPEG together.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function digestCardImagesDir(config) {
  const dbPath = (config && config.dbPath) || './data/news-digest.db';
  return join(dirname(resolve(dbPath)), 'digest-card-images');
}

export function ensureDigestCardImagesDir(config) {
  const directory = digestCardImagesDir(config);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function existingDigestCardImagePath(config, imageFile) {
  if (!imageFile || !/^[0-9a-f-]{36}\.jpg$/iu.test(imageFile)) return null;
  const imagePath = join(digestCardImagesDir(config), imageFile);
  return existsSync(imagePath) ? imagePath : null;
}

/** Public HTTPS location a future Instagram publisher must use for this asset. */
export function digestCardPublicUrl(config, imageFile) {
  if (!imageFile || !/^[0-9a-f-]{36}\.jpg$/iu.test(imageFile)) {
    throw new Error('Digest card image filename is invalid');
  }
  const baseUrl = String(config?.baseUrl || '').replace(/\/+$/u, '');
  if (!/^https:\/\//iu.test(baseUrl)) {
    throw new Error('BASE_URL must be an HTTPS URL before an Instagram card can be published');
  }
  return `${baseUrl}/digest-card-images/${imageFile}`;
}
