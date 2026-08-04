import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);

const versionedPages = [
  'src/public/index.html',
  'src/pro/public/syndication.html',
  'src/pro/moderation/public/moderation.html',
].filter((relativePath) => existsSync(`${repoRoot}${relativePath}`));

describe('visible application version badges', () => {
  for (const relativePath of versionedPages) {
    it(`${relativePath} matches package.json`, async () => {
      const html = await readFile(`${repoRoot}${relativePath}`, 'utf8');
      expect(html).toContain(
        `<span class="version-badge">v${packageJson.version}`,
      );
    });
  }
});
