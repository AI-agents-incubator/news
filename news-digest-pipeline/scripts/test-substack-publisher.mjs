import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const testPath = 'production/substack-publisher/test/substack-publisher.test.js';

if (!existsSync(testPath)) {
  console.log('[test] Substack publisher package is not part of this edition; skipped.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', testPath], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
