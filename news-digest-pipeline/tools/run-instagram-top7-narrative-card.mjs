#!/usr/bin/env node

// Produce a review-only five-hook prose card. It reads one explicit local
// digest, makes exactly one semantic model call, and never imports publishing.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import {
  WHITE_CARD_MODEL,
  WHITE_CARD_REASONING,
  WHITE_CARD_VENDOR,
  createTop5HookCard,
  extractTop7Headlines,
  renderTop5HookCard,
  sha256,
} from '../src/pro/services/instagram-white-card.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAB_ROOT = join(ROOT, 'instagram', 'white-card-lab');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return 'Usage: node tools/run-instagram-top7-narrative-card.mjs --input <digest.txt> --run-id <immutable-id> --digest-number <number> --digest-date <YYYY-MM-DD> --additional-news-count <number>';
}

function safeRunId(value) {
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(value || '')) {
    throw new Error('run id must contain only letters, numbers, and hyphens (3-81 chars)');
  }
  return value;
}

function digestNumber(value) {
  if (!/^\d{1,6}\+?$/u.test(value || '')) {
    throw new Error('digest number must be a positive number, optionally followed by +');
  }
  return value;
}

function digestDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) throw new Error('digest date must use YYYY-MM-DD');
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('digest date must be a real calendar date');
  }
  return value;
}

function positiveInteger(value, label) {
  if (!/^\d+$/u.test(value || '') || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function now() {
  return new Date().toISOString();
}

function usageRecord({ runId, promptSha256, inputTokens, outputTokens, status, error = null }) {
  return {
    schema_version: 'instagram-top5-hook-card-lab.usage.v1',
    run_id: runId,
    step: 'selected-hook-announcements',
    attempt: 1,
    provider: WHITE_CARD_VENDOR,
    model: WHITE_CARD_MODEL,
    reasoning_effort: WHITE_CARD_REASONING,
    prompt_sha256: promptSha256,
    input_tokens: inputTokens ?? 'not_reported_by_provider',
    output_tokens: outputTokens ?? 'not_reported_by_provider',
    status,
    error,
    at: now(),
  };
}

async function main() {
  const inputArg = arg('--input');
  const runIdArg = arg('--run-id');
  const digestNumberArg = arg('--digest-number');
  const digestDateArg = arg('--digest-date');
  const additionalNewsCountArg = arg('--additional-news-count');
  if (!inputArg || !runIdArg || !digestNumberArg || !digestDateArg || !additionalNewsCountArg) throw new Error(usage());
  const runId = safeRunId(runIdArg);
  const cardMetadata = {
    digestNumber: digestNumber(digestNumberArg),
    digestDate: digestDate(digestDateArg),
    additionalNewsCount: positiveInteger(additionalNewsCountArg, 'additional news count'),
  };
  const inputPath = resolve(ROOT, inputArg);
  if (!existsSync(inputPath)) throw new Error(`input file not found: ${inputArg}`);
  const runDir = join(LAB_ROOT, 'runs', runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runId}`);
  // The lab deliberately uses the same canonical, versioned production prompt
  // as automatic digest generation. This keeps visual previews useful without
  // maintaining a second editable copy of editorial instructions.
  const promptPath = join(ROOT, 'src', 'pro', 'prompts', 'instagram-top5-hook.v1.md');
  const [digestText, prompt] = await Promise.all([readFile(inputPath, 'utf8'), readFile(promptPath, 'utf8')]);
  const sourceEntries = extractTop7Headlines(digestText).map(({ number, headline }) => ({ number, text: headline }));
  const input = {
    source_file: inputArg,
    source_basename: basename(inputPath),
    source_sha256: sha256(digestText),
    source_characters: Array.from(digestText).length,
    card_metadata: cardMetadata,
    recorded_at: now(),
  };
  const promptSha256 = sha256(prompt);

  await mkdir(runDir, { recursive: false });
  await writeFile(join(runDir, '00-input.json'), JSON.stringify(input, null, 2) + '\n');
  await writeFile(join(runDir, '01-source-entries.json'), JSON.stringify({
    schema_version: 'instagram-top7-narrative-card-lab.sources.v1',
    source_sha256: input.source_sha256,
    entries: sourceEntries,
  }, null, 2) + '\n');
  await writeFile(join(runDir, '02-hook.request.json'), JSON.stringify({
    prompt_file: 'src/pro/prompts/instagram-top5-hook.v1.md', prompt_sha256: promptSha256,
    provider: WHITE_CARD_VENDOR, model: WHITE_CARD_MODEL, reasoning_effort: WHITE_CARD_REASONING,
    source_sha256: input.source_sha256,
  }, null, 2) + '\n');

  try {
    const { card, usage } = await createTop5HookCard(config, {
      prompt,
      sources: sourceEntries,
      remainingNewsCount: cardMetadata.additionalNewsCount,
    });
    await writeFile(join(runDir, '02-hook.result.json'), JSON.stringify(card, null, 2) + '\n');
    const rendered = await renderTop5HookCard(
      card,
      join(runDir, 'preview-1080x1350.png'),
      cardMetadata,
    );
    await writeFile(join(runDir, '03-render.result.json'), JSON.stringify(rendered, null, 2) + '\n');
    await writeFile(join(runDir, 'usage.ndjson'), JSON.stringify(usageRecord({
      runId, promptSha256, ...usage, status: 'succeeded',
    })) + '\n');
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 'instagram-top5-hook-card-lab.run.v1', run_id: runId, status: 'succeeded',
      input, prompt_sha256: promptSha256, source_count: sourceEntries.length, card_metadata: cardMetadata,
      output: rendered, created_at: now(),
    }, null, 2) + '\n');
    console.log(JSON.stringify({ runId, preview: rendered.outputPath, status: 'succeeded' }));
  } catch (error) {
    const message = String(error?.message || error).replace(/(api[_ -]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
    await writeFile(join(runDir, 'usage.ndjson'), JSON.stringify(usageRecord({
      runId, promptSha256, status: 'failed', error: message,
    })) + '\n');
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({
      schema_version: 'instagram-top5-hook-card-lab.run.v1', run_id: runId, status: 'failed',
      input, prompt_sha256: promptSha256, source_count: sourceEntries.length, error: message, created_at: now(),
    }, null, 2) + '\n');
    throw error;
  }
}

main().catch((error) => {
  console.error(`top5 hook white-card run failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
