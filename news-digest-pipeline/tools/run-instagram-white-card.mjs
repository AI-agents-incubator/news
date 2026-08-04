#!/usr/bin/env node

// Create a review-only white Instagram card from one explicit local digest
// file. The run never imports the autoposter or Instagram credentials.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import {
  WHITE_CARD_MODEL,
  WHITE_CARD_REASONING,
  WHITE_CARD_VENDOR,
  createWhiteCardBrief,
  renderWhiteCard,
  sha256,
} from '../src/pro/services/instagram-white-card.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAB_ROOT = join(ROOT, 'instagram', 'white-card-lab');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return 'Usage: node tools/run-instagram-white-card.mjs --input <digest.txt> --run-id <immutable-id>';
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

function usageRecord({ runId, promptSha256, inputTokens, outputTokens, status, error = null }) {
  return {
    schema_version: 'instagram-white-card-lab.usage.v1',
    run_id: runId,
    step: 'editorial-summary',
    attempt: 1,
    provider: WHITE_CARD_VENDOR,
    model: WHITE_CARD_MODEL,
    reasoning_effort: WHITE_CARD_REASONING,
    prompt_sha256: promptSha256,
    input_tokens: inputTokens ?? 'not_reported_by_provider',
    output_tokens: outputTokens ?? 'not_reported_by_provider',
    total_tokens: Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
      ? inputTokens + outputTokens : 'not_reported_by_provider',
    status,
    error,
    at: now(),
  };
}

async function main() {
  const inputArg = arg('--input');
  const runId = safeRunId(arg('--run-id'));
  if (!inputArg || !runId) throw new Error(usage());

  const inputPath = resolve(ROOT, inputArg);
  if (!existsSync(inputPath)) throw new Error(`input file not found: ${inputArg}`);
  const runDir = join(LAB_ROOT, 'runs', runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runId}`);
  const promptPath = join(LAB_ROOT, 'prompts', 'editorial-summary.v1.md');
  const [digestText, prompt] = await Promise.all([readFile(inputPath, 'utf8'), readFile(promptPath, 'utf8')]);
  if (!digestText.trim()) throw new Error('input digest is empty');

  await mkdir(runDir, { recursive: false });
  const promptHash = sha256(prompt);
  const inputHash = sha256(digestText);
  const inputMeta = {
    source_file: inputArg,
    source_basename: basename(inputPath),
    source_sha256: inputHash,
    source_characters: Array.from(digestText).length,
    recorded_at: now(),
  };
  await writeFile(join(runDir, '00-input.json'), JSON.stringify(inputMeta, null, 2) + '\n');
  await writeFile(join(runDir, '01-summary.request.json'), JSON.stringify({
    prompt_file: 'editorial-summary.v1.md', prompt_sha256: promptHash,
    provider: WHITE_CARD_VENDOR, model: WHITE_CARD_MODEL, reasoning_effort: WHITE_CARD_REASONING,
    source_sha256: inputHash,
  }, null, 2) + '\n');

  try {
    const { card, usage } = await createWhiteCardBrief(config, { prompt, digestText });
    await writeFile(join(runDir, '01-summary.result.json'), JSON.stringify(card, null, 2) + '\n');
    const rendered = await renderWhiteCard(card, join(runDir, 'preview-1080x1350.png'));
    await writeFile(join(runDir, '02-render.result.json'), JSON.stringify(rendered, null, 2) + '\n');
    await writeFile(join(runDir, 'usage.ndjson'), JSON.stringify(usageRecord({
      runId, promptSha256: promptHash, ...usage, status: 'succeeded',
    })) + '\n');
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 'instagram-white-card-lab.run.v1', run_id: runId, status: 'succeeded',
      input: inputMeta, prompt_sha256: promptHash, output: rendered, created_at: now(),
    }, null, 2) + '\n');
    console.log(JSON.stringify({ runId, preview: join(runDir, 'preview-1080x1350.png'), status: 'succeeded' }));
  } catch (error) {
    const message = String(error?.message || error).replace(/(api[_ -]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
    await writeFile(join(runDir, 'usage.ndjson'), JSON.stringify(usageRecord({
      runId, promptSha256: promptHash, status: 'failed', error: message,
    })) + '\n');
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 'instagram-white-card-lab.run.v1', run_id: runId, status: 'failed',
      input: inputMeta, prompt_sha256: promptHash, error: message, created_at: now(),
    }, null, 2) + '\n');
    throw error;
  }
}

main().catch((error) => {
  console.error(`white-card run failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
