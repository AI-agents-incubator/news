#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { exactKeys, parseEditorialV2, parseVisualV1, sha256, USAGE_NOT_REPORTED, USAGE_UNKNOWN } from '../lib/contracts.mjs';

const here = new URL('.', import.meta.url).pathname;
const LAB = resolve(here, '..');
const target = process.argv[2] || '--samples';
let failures = 0;
const fail = (message) => { failures++; console.error(`FAIL: ${message}`); };

function readJson(path, context) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${context}: invalid JSON (${error.message})`);
    return null;
  }
}

function isContained(runDir, candidate) {
  const absolute = resolve(runDir, candidate);
  return relative(runDir, absolute) && !relative(runDir, absolute).startsWith('..');
}

function verifyUsageRecord(record, sampleId, step, result, context) {
  const required = [
    'schema_version', 'run_id', 'sample_id', 'step', 'attempt', 'provider', 'model',
    'reasoning_effort', 'rendered_prompt_sha256', 'input_tokens', 'output_tokens',
    'total_tokens', 'provider_request_id', 'status', 'at',
  ];
  if (!exactKeys(record, required)) fail(`${context}: usage ledger record shape is invalid`);
  if (record.schema_version !== 'instagram-cover-lab.usage.v1') fail(`${context}: usage schema version is invalid`);
  if (record.sample_id !== sampleId || record.step !== step || record.attempt !== 1) fail(`${context}: usage sample/step/attempt mismatch`);
  if (!['succeeded', 'rejected', 'failed'].includes(record.status)) fail(`${context}: usage status is invalid`);
  if (!/^\d{4}-\d\d-\d\dT/.test(String(record.at))) fail(`${context}: usage timestamp is invalid`);
  if (!/^[a-f0-9]{64}$/.test(String(record.rendered_prompt_sha256))) fail(`${context}: usage prompt hash is invalid`);
  for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (!(Number.isInteger(record[field]) && record[field] >= 0)
      && record[field] !== USAGE_NOT_REPORTED && record[field] !== USAGE_UNKNOWN) {
      fail(`${context}: usage ${field} must be a non-negative integer, ${USAGE_UNKNOWN}, or ${USAGE_NOT_REPORTED}`);
    }
  }
  if (result?.usage) {
    for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) {
      if (record[field] !== result.usage[field]) fail(`${context}: usage ${field} does not match result`);
    }
  }
}

function verifyRequest(runDir, file, context) {
  const request = readJson(file, context);
  if (!request) return null;
  const promptPath = resolve(LAB, request.prompt?.file || '');
  if (!isContained(LAB, request.prompt?.file || '') || !existsSync(promptPath)) {
    fail(`${context}: prompt file is missing or outside the lab`);
  } else if (sha256(readFileSync(promptPath, 'utf8')) !== request.prompt.sha256) {
    fail(`${context}: recorded prompt hash no longer matches immutable prompt`);
  }
  if (typeof request.rendered_prompt !== 'string' || sha256(request.rendered_prompt) !== request.rendered_prompt_sha256) {
    fail(`${context}: rendered prompt hash mismatch`);
  }
  if (sha256(JSON.stringify(request.input)) !== request.input_sha256) fail(`${context}: input hash mismatch`);
  return request;
}

function validateLegacyRun(runDir, run) {
  for (const sample of run.samples || []) {
    const dir = join(runDir, 'samples', sample.sample_id);
    for (const file of ['00-source.json', '01-editorial.request.json', '01-editorial.result.json', '02-visual-brief.request.json', '02-visual-brief.result.json', '03-background.request.json', '04-composition.request.json']) {
      if (sample.status === 'failed' && !existsSync(join(dir, file))) continue;
      if (!existsSync(join(dir, file))) { fail(`${sample.sample_id}: missing ${file}`); continue; }
      readJson(join(dir, file), `${sample.sample_id}: ${file}`);
    }
  }
}

async function validateV2Run(runDir, run) {
  if (!Array.isArray(run.samples) || run.samples.length !== 10) fail('v2 manifest must contain exactly ten samples');
  const candidateReview = run.mode === 'candidate_review';
  if (!candidateReview && run.mode !== 'full') fail('v2 manifest mode must be full or candidate_review');
  const ledgerFile = join(runDir, 'usage.ndjson');
  if (!existsSync(ledgerFile)) {
    fail('v2 run is missing usage.ndjson');
    return;
  }
  const ledgerByKey = new Map();
  const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let record;
    try { record = JSON.parse(line); } catch { fail(`usage.ndjson line ${index + 1}: invalid JSON`); continue; }
    const key = `${record.sample_id}:${record.step}:${record.attempt}`;
    if (ledgerByKey.has(key)) fail(`usage.ndjson duplicates ${key}`);
    ledgerByKey.set(key, record);
  }

  for (const sample of run.samples || []) {
    const sampleId = sample.sample_id;
    const dir = join(runDir, 'samples', sampleId);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) { fail(`${sampleId}: missing sample directory`); continue; }
    const source = readJson(join(dir, '00-source.json'), `${sampleId}: source`);
    if (!source || sha256(source.text) !== source.source_text_sha256) fail(`${sampleId}: source text hash mismatch`);

    const steps = [
      ['01-editorial', '01-editorial.request.json', '01-editorial.result.json'],
      ...(!candidateReview ? [
        ['02-visual-brief', '02-visual-brief.request.json', '02-visual-brief.result.json'],
        ['03-background', '03-background.request.json', '03-background.result.json'],
        ['04-composition', '04-composition.request.json', '04-composition.result.json'],
      ] : []),
    ];
    for (const [step, requestName, resultName] of steps) {
      const requestPath = join(dir, requestName);
      const resultPath = join(dir, resultName);
      if (!existsSync(requestPath) || !existsSync(resultPath)) {
        fail(`${sampleId}: missing ${requestName} or ${resultName}`);
        continue;
      }
      const request = verifyRequest(runDir, requestPath, `${sampleId}: ${requestName}`);
      const result = readJson(resultPath, `${sampleId}: ${resultName}`);
      const ledger = ledgerByKey.get(`${sampleId}:${step}:1`);
      if (!ledger) fail(`${sampleId}: ledger has no ${step} attempt`);
      else verifyUsageRecord(ledger, sampleId, step, result, `${sampleId}: ${step}`);
      if (request && ledger && request.rendered_prompt_sha256 !== ledger.rendered_prompt_sha256) {
        fail(`${sampleId}: ${step} ledger prompt hash mismatch`);
      }
      if (!result) continue;
      if (result.status !== 'accepted' && result.status !== 'generated') fail(`${sampleId}: ${step} result status is not complete`);
      if (step === '01-editorial') {
        try { parseEditorialV2(JSON.stringify(result.result)); } catch (error) { fail(`${sampleId}: editorial contract: ${error.message}`); }
        if (sha256(JSON.stringify(result.result)) !== result.result_sha256) fail(`${sampleId}: editorial result hash mismatch`);
      }
      if (step === '02-visual-brief') {
        try { parseVisualV1(JSON.stringify(result.result)); } catch (error) { fail(`${sampleId}: visual contract: ${error.message}`); }
        if (sha256(JSON.stringify(result.result)) !== result.result_sha256) fail(`${sampleId}: visual result hash mismatch`);
      }
      if (step.startsWith('03') || step.startsWith('04')) {
        const image = result.image;
        const providerUrl = result.provider_output?.url;
        if (!image || typeof providerUrl !== 'string' || !providerUrl.startsWith('https://')) {
          fail(`${sampleId}: ${step} is missing provider output URL`);
          continue;
        }
        if (!isContained(dir, image.output_file) || basename(image.output_file) !== image.output_file) {
          fail(`${sampleId}: ${step} output_file escapes sample directory`);
          continue;
        }
        const output = join(dir, image.output_file);
        if (!existsSync(output)) { fail(`${sampleId}: ${step} output image is missing`); continue; }
        const bytes = readFileSync(output);
        if (sha256(bytes) !== image.output_sha256 || bytes.length !== image.bytes) fail(`${sampleId}: ${step} output hash or byte count mismatch`);
        const metadata = await sharp(output).metadata();
        if (metadata.width !== 1080 || metadata.height !== 1350 || image.width !== 1080 || image.height !== 1350) {
          fail(`${sampleId}: ${step} is not a normalized 1080x1350 image`);
        }
      }
    }
  }
  const expectedLedgerCount = (run.samples || []).length * (candidateReview ? 1 : 4);
  if (ledgerByKey.size !== expectedLedgerCount) fail(`usage ledger parity mismatch: expected ${expectedLedgerCount}, found ${ledgerByKey.size}`);
}

if (target === '--samples') {
  const input = readJson(join(LAB, 'samples.v1.json'), 'samples');
  if (input?.samples?.length !== 10) fail('sample count must be 10');
  const ids = new Set();
  for (const sample of input?.samples || []) {
    if (ids.has(sample.pfbid)) fail(`duplicate pfbid ${sample.pfbid}`);
    ids.add(sample.pfbid);
    const url = new URL(sample.source_url);
    if (url.search || url.hash || url.protocol !== 'https:' || url.hostname !== 'www.facebook.com') fail(`unsafe url ${sample.sample_id}`);
  }
} else {
  const runDir = resolve(process.cwd(), target);
  const manifestPath = join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) fail('manifest.json not found');
  else {
    const run = readJson(manifestPath, 'manifest');
    if (run?.schema_version === 'instagram-cover-lab.run.v2') await validateV2Run(runDir, run);
    else if (run) validateLegacyRun(runDir, run);
  }
}
if (failures) process.exit(1);
console.log('VALID');
