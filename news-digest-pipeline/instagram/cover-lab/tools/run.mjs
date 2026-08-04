#!/usr/bin/env node

// Immutable, application-executed four-stage Cover Lab run.
// Semantic content is created only by callModel() and generateFalGraphic().

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import appConfig from '../../../src/config.js';
import { generateFalGraphic, FAL_GRAPHIC_MODELS } from '../../../src/services/fal-graphic.js';
import { callModel } from '../../../src/services/llm.js';
import { readFacebookPost } from '../../../src/pro/services/fb-reader.js';
import {
  modelUsage,
  parseEditorialV2,
  parseVisualV1,
  safeError,
  sha256,
  usageRecord,
  USAGE_NOT_REPORTED,
} from '../lib/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, '..');
const PROMPTS = join(LAB, 'prompts');
const RUNS = join(LAB, 'runs');
const DEFAULT_RUN_ID = `fb10-r02-${new Date().toISOString().slice(0, 10)}`;
const TEXT_REASONING_EFFORT = 'medium';

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeNewJson(file, value) {
  if (existsSync(file)) throw new Error(`immutable artifact already exists: ${file}`);
  writeJson(file, value);
}

function cleanPermalink(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com'
    || url.search || url.hash || !/^\/alex\.v\.krol\/posts\/pfbid[A-Za-z0-9]+$/.test(url.pathname)) {
    throw new Error(`Unsafe sample permalink: ${value}`);
  }
  return url.toString();
}

function loadPrompt(name) {
  const file = join(PROMPTS, name);
  const text = readFileSync(file, 'utf8');
  const match = name.match(/^(.*)\.(v\d+)\.md$/);
  return { file: relative(LAB, file), id: match?.[1] || name, version: match?.[2] || 'unknown', text, sha256: sha256(text) };
}

function render(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll(`{{${key}}}`, value);
  if (/{{[A-Z_]+}}/.test(rendered)) throw new Error('unresolved prompt placeholder');
  return rendered;
}

function requestArtifact(step, prompt, rendered, input, model) {
  return {
    schema_version: 'instagram-cover-lab.request.v2',
    step,
    status: 'executed',
    prompt: { id: prompt.id, version: prompt.version, file: prompt.file, sha256: prompt.sha256 },
    rendered_prompt: rendered,
    rendered_prompt_sha256: sha256(rendered),
    input,
    input_sha256: sha256(JSON.stringify(input)),
    model,
  };
}

function graphicUsage(graphic) {
  return {
    input_tokens: graphic.usage.inputTokens,
    output_tokens: graphic.usage.outputTokens,
    total_tokens: graphic.usage.totalTokens,
  };
}

function appendUsage(runDir, entry) {
  appendFileSync(join(runDir, 'usage.ndjson'), `${JSON.stringify(entry)}\n`);
}

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}

function assertRunId(value) {
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(value)) throw new Error('run id must contain only letters, numbers, and hyphens');
}

async function downloadAndNormalizeImage(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`provider image download failed: HTTP ${response.status}`);
  const original = Buffer.from(await response.arrayBuffer());
  const normalized = await sharp(original).rotate().resize(1080, 1350, { fit: 'cover', position: 'centre' }).png().toBuffer();
  writeFileSync(outputPath, normalized, { flag: 'wx' });
  const metadata = await sharp(normalized).metadata();
  if (metadata.width !== 1080 || metadata.height !== 1350) throw new Error('normalization did not produce 1080x1350');
  return {
    output_file: relative(dirname(outputPath), outputPath),
    mime: 'image/png',
    width: metadata.width,
    height: metadata.height,
    bytes: normalized.length,
    output_sha256: sha256(normalized),
  };
}

async function executeTextStep({ runDir, sample, sampleDir, step, prompt, rendered, input, model, parse, resultName }) {
  const request = requestArtifact(step, prompt, rendered, input, {
    provider: model.vendor,
    model: model.name,
    reasoning_effort: model.reasoningEffort,
  });
  writeNewJson(join(sampleDir, `${resultName}.request.json`), request);
  let call;
  try {
    call = await callModel(appConfig, {
      system: rendered,
      user: 'Return the required JSON now.',
      maxTokens: step === '01-editorial' ? 1_300 : 1_100,
      vendor: model.vendor,
      model: model.name,
      reasoningEffort: model.reasoningEffort,
    });
    const usage = modelUsage(call);
    let result;
    try {
      result = parse(call.text);
    } catch (error) {
      writeNewJson(join(sampleDir, `${resultName}.result.json`), {
        schema_version: 'instagram-cover-lab.text-result.v2', step, status: 'rejected',
        raw_response: call.text, error: safeError(error), usage,
      });
      appendUsage(runDir, usageRecord({
        runId: basename(runDir), sampleId: sample.sample_id, step, attempt: 1,
        provider: model.vendor, model: model.name, reasoningEffort: model.reasoningEffort,
        promptSha256: request.rendered_prompt_sha256, usage, status: 'rejected', at: new Date().toISOString(),
      }));
      throw error;
    }
    writeNewJson(join(sampleDir, `${resultName}.result.json`), {
      schema_version: 'instagram-cover-lab.text-result.v2', step, status: 'accepted', result,
      result_sha256: sha256(JSON.stringify(result)), usage,
    });
    appendUsage(runDir, usageRecord({
      runId: basename(runDir), sampleId: sample.sample_id, step, attempt: 1,
      provider: model.vendor, model: model.name, reasoningEffort: model.reasoningEffort,
      promptSha256: request.rendered_prompt_sha256, usage, status: 'succeeded', at: new Date().toISOString(),
    }));
    return result;
  } catch (error) {
    if (!call) {
      const usage = { input_tokens: USAGE_NOT_REPORTED, output_tokens: USAGE_NOT_REPORTED, total_tokens: USAGE_NOT_REPORTED };
      writeNewJson(join(sampleDir, `${resultName}.result.json`), {
        schema_version: 'instagram-cover-lab.text-result.v2', step, status: 'failed', error: safeError(error), usage,
      });
      appendUsage(runDir, usageRecord({
        runId: basename(runDir), sampleId: sample.sample_id, step, attempt: 1,
        provider: model.vendor, model: model.name, reasoningEffort: model.reasoningEffort,
        promptSha256: request.rendered_prompt_sha256, usage, status: 'failed', at: new Date().toISOString(),
      }));
    }
    throw error;
  }
}

async function executeGraphicStep({ runDir, sample, sampleDir, step, prompt, rendered, input, mode, backgroundImageUrl = null }) {
  const model = FAL_GRAPHIC_MODELS[mode];
  const request = requestArtifact(step, prompt, rendered, input, {
    provider: 'fal.ai', model, reasoning_effort: 'not_applicable',
  });
  const resultName = step === '03-background' ? '03-background' : '04-composition';
  writeNewJson(join(sampleDir, `${resultName}.request.json`), request);
  let graphic;
  try {
    graphic = await generateFalGraphic(appConfig, {
      mode, prompt: rendered, width: 1080, height: 1350, backgroundImageUrl,
    });
    const usage = graphicUsage(graphic);
    const image = await downloadAndNormalizeImage(graphic.output.url, join(sampleDir, `${resultName}.png`));
    writeNewJson(join(sampleDir, `${resultName}.result.json`), {
      schema_version: 'instagram-cover-lab.image-result.v2', step, status: 'generated',
      provider: graphic.provider, model: graphic.model, provider_request_id: graphic.requestId,
      request_file: `${resultName}.request.json`, request_sha256: sha256(readFileSync(join(sampleDir, `${resultName}.request.json`))),
      provider_request: graphic.request,
      provider_output: graphic.output,
      provider_usage: graphic.usage,
      image,
      usage,
      generated_at: new Date().toISOString(),
    });
    appendUsage(runDir, usageRecord({
      runId: basename(runDir), sampleId: sample.sample_id, step, attempt: 1,
      provider: graphic.provider, model: graphic.model, reasoningEffort: 'not_applicable',
      promptSha256: request.rendered_prompt_sha256, usage, status: 'succeeded', at: new Date().toISOString(),
      requestId: graphic.requestId,
    }));
    return graphic;
  } catch (error) {
    const usage = graphic ? graphicUsage(graphic) : {
      input_tokens: USAGE_NOT_REPORTED, output_tokens: USAGE_NOT_REPORTED, total_tokens: USAGE_NOT_REPORTED,
    };
    writeNewJson(join(sampleDir, `${resultName}.result.json`), {
      schema_version: 'instagram-cover-lab.image-result.v2', step, status: 'failed', error: safeError(error), usage,
    });
    appendUsage(runDir, usageRecord({
      runId: basename(runDir), sampleId: sample.sample_id, step, attempt: 1,
      provider: graphic?.provider || 'fal.ai', model: graphic?.model || model, reasoningEffort: 'not_applicable',
      promptSha256: request.rendered_prompt_sha256, usage, status: 'failed', at: new Date().toISOString(),
      requestId: graphic?.requestId || null,
    }));
    throw error;
  }
}

const requestedRunId = argValue('--run-id') || DEFAULT_RUN_ID;
assertRunId(requestedRunId);
const candidateReview = process.argv.includes('--candidate-review');
const runDir = join(RUNS, requestedRunId);
if (existsSync(runDir)) throw new Error(`immutable run already exists: ${runDir}`);
mkdirSync(runDir, { recursive: true });

const sampleDocument = JSON.parse(readFileSync(join(LAB, 'samples.v1.json'), 'utf8'));
if (!Array.isArray(sampleDocument.samples) || sampleDocument.samples.length !== 10) throw new Error('samples.v1.json must contain exactly 10 samples');
const pfbids = new Set();
for (const sample of sampleDocument.samples) {
  sample.source_url = cleanPermalink(sample.source_url);
  if (pfbids.has(sample.pfbid)) throw new Error(`duplicate pfbid ${sample.pfbid}`);
  pfbids.add(sample.pfbid);
}

const editorialPrompt = loadPrompt('editorial-card.v2.md');
const visualPrompt = loadPrompt('visual-director.v1.md');
const backgroundPrompt = loadPrompt('background-image.v1.md');
const compositionPrompt = loadPrompt('cover-composition.v1.md');
const textModel = {
  vendor: process.env.COVER_LAB_LLM_VENDOR || appConfig.llmVendor,
  name: process.env.COVER_LAB_TEXT_MODEL || appConfig.claudeModel,
  reasoningEffort: TEXT_REASONING_EFFORT,
};
const run = {
  schema_version: 'instagram-cover-lab.run.v2',
  run_id: requestedRunId,
  created_at: new Date().toISOString(),
  mode: candidateReview ? 'candidate_review' : 'full',
  selection: sampleDocument.selection,
  text_model: textModel,
  graphic_models: FAL_GRAPHIC_MODELS,
  prompts: [editorialPrompt, visualPrompt, backgroundPrompt, compositionPrompt].map(({ text, ...meta }) => meta),
  samples: [],
};
writeJson(join(runDir, 'manifest.json'), run);

for (const sample of sampleDocument.samples) {
  const sampleDir = join(runDir, 'samples', sample.sample_id);
  mkdirSync(sampleDir, { recursive: true });
  const record = { sample_id: sample.sample_id, source_post_id: sample.source_post_id, pfbid: sample.pfbid, status: 'started' };
  run.samples.push(record);
  try {
    const fetched = await readFacebookPost(sample.source_url);
    if (!fetched.text || fetched.pfbid !== sample.pfbid) throw new Error('Facebook reader returned incomplete or mismatched source data');
    const source = {
      sample_id: sample.sample_id, source_post_id: sample.source_post_id, pfbid: sample.pfbid,
      source_url: sample.source_url, author: fetched.author || null, text_source: fetched.text_source || null,
      text: fetched.text, source_text_sha256: sha256(fetched.text),
    };
    writeNewJson(join(sampleDir, '00-source.json'), source);

    const editorialRendered = render(editorialPrompt.text, { SOURCE_POST_JSON: JSON.stringify(source, null, 2) });
    const editorial = await executeTextStep({
      runDir, sample, sampleDir, step: '01-editorial', prompt: editorialPrompt, rendered: editorialRendered,
      input: source, model: textModel, parse: parseEditorialV2, resultName: '01-editorial',
    });
    if (candidateReview) {
      // This is an inspectable API-evidence mode. It stops before downstream
      // model calls and never injects a human-selected replacement.
      record.status = 'candidate_review_ready';
      writeJson(join(runDir, 'manifest.json'), run);
      continue;
    }
    const visualInput = { source, editorial_card: editorial };
    const visualRendered = render(visualPrompt.text, {
      EDITORIAL_CARD_JSON: JSON.stringify(editorial, null, 2), SOURCE_POST_JSON: JSON.stringify(source, null, 2),
    });
    const visual = await executeTextStep({
      runDir, sample, sampleDir, step: '02-visual-brief', prompt: visualPrompt, rendered: visualRendered,
      input: visualInput, model: textModel, parse: parseVisualV1, resultName: '02-visual-brief',
    });
    const backgroundRendered = render(backgroundPrompt.text, { VISUAL_BRIEF_JSON: JSON.stringify(visual, null, 2) });
    const background = await executeGraphicStep({
      runDir, sample, sampleDir, step: '03-background', prompt: backgroundPrompt, rendered: backgroundRendered,
      input: { visual_brief: visual }, mode: 'background',
    });
    const compositionRendered = render(compositionPrompt.text, {
      HOOK: editorial.hook,
      DEK: editorial.selected_logline,
      TEXT_SAFE_ZONE: visual.composition.text_safe_zone,
    });
    await executeGraphicStep({
      runDir, sample, sampleDir, step: '04-composition', prompt: compositionPrompt, rendered: compositionRendered,
      input: {
        background_provider_url: background.output.url,
        hook: editorial.hook,
        selected_logline: editorial.selected_logline,
        text_safe_zone: visual.composition.text_safe_zone,
      },
      mode: 'composition', backgroundImageUrl: background.output.url,
    });
    record.status = 'complete';
  } catch (error) {
    record.status = 'failed';
    record.error = safeError(error);
  }
  writeJson(join(runDir, 'manifest.json'), run);
}

const completedStatus = candidateReview ? 'candidate_review_ready' : 'complete';
const completed = run.samples.filter((sample) => sample.status === completedStatus).length;
console.log(JSON.stringify({ run_dir: runDir, mode: run.mode, completed, failed: run.samples.length - completed }));
if (completed !== run.samples.length) process.exitCode = 1;
