#!/usr/bin/env node

// Render a review-only top-ten card from an explicit local digest. This tool
// never imports the autoposter, credentials, Graph API, or a language model.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTop10Headlines,
  renderTop10Card,
  sha256,
} from '../src/pro/services/instagram-white-card.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAB_ROOT = join(ROOT, 'instagram', 'white-card-lab');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return 'Usage: node tools/run-instagram-top10-card.mjs --input <digest.txt> --run-id <immutable-id>';
}

function safeRunId(value) {
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(value || '')) {
    throw new Error('run id must contain only letters, numbers, and hyphens (3-81 chars)');
  }
  return value;
}

function now() {
  return new Date().toISOString();
}

async function main() {
  const inputArg = arg('--input');
  const runIdArg = arg('--run-id');
  if (!inputArg || !runIdArg) throw new Error(usage());
  const runId = safeRunId(runIdArg);
  const inputPath = resolve(ROOT, inputArg);
  if (!existsSync(inputPath)) throw new Error(`input file not found: ${inputArg}`);
  const runDir = join(LAB_ROOT, 'runs', runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runId}`);

  const digestText = await readFile(inputPath, 'utf8');
  const entries = extractTop10Headlines(digestText);
  const input = {
    source_file: inputArg,
    source_basename: basename(inputPath),
    source_sha256: sha256(digestText),
    source_characters: Array.from(digestText).length,
    recorded_at: now(),
  };
  const extracted = {
    schema_version: 'instagram-top10-white-card-lab.extracted-headlines.v1',
    source_sha256: input.source_sha256,
    count: entries.length,
    entries,
  };

  await mkdir(runDir, { recursive: false });
  await writeFile(join(runDir, '00-input.json'), JSON.stringify(input, null, 2) + '\n');
  await writeFile(join(runDir, '01-extracted-headlines.json'), JSON.stringify(extracted, null, 2) + '\n');

  try {
    const rendered = await renderTop10Card(entries, join(runDir, 'preview-1080x1350.png'));
    await writeFile(join(runDir, '02-render.result.json'), JSON.stringify(rendered, null, 2) + '\n');
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 'instagram-top10-white-card-lab.run.v1',
      run_id: runId,
      status: 'succeeded',
      input,
      extracted: {
        file: '01-extracted-headlines.json',
        count: entries.length,
        sha256: sha256(JSON.stringify(extracted)),
      },
      output: rendered,
      created_at: now(),
    }, null, 2) + '\n');
    console.log(JSON.stringify({ runId, preview: rendered.outputPath, status: 'succeeded' }));
  } catch (error) {
    const message = String(error?.message || error);
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 'instagram-top10-white-card-lab.run.v1',
      run_id: runId,
      status: 'failed',
      input,
      extracted: { file: '01-extracted-headlines.json', count: entries.length },
      error: message,
      created_at: now(),
    }, null, 2) + '\n');
    throw error;
  }
}

main().catch((error) => {
  console.error(`top10 white-card run failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
