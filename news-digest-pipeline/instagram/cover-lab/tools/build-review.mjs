#!/usr/bin/env node
// Static, local-only review page for an already completed Cover Lab run.
// It deliberately has no model, Facebook, database, or publishing imports.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = resolve(TOOLS_DIR, '..');
const RUNS_DIR = resolve(LAB_DIR, 'runs');

function fail(message) {
  throw new Error(`build-review: ${message}`);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error.message}`);
  }
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '—';
}

function readOptionalJson(path) {
  return existsSync(path) ? readJson(path) : null;
}

function imageBlock(sampleId, file, label) {
  const relativePath = `samples/${sampleId}/${file}`;
  const absolutePath = join(RUNS_DIR, currentRunId, relativePath);
  if (!existsSync(absolutePath)) {
    return `<div class="image missing"><strong>${escapeHtml(label)}</strong><span>Артефакт не найден</span></div>`;
  }
  const escapedPath = escapeHtml(relativePath);
  return `<a class="image" href="${escapedPath}">
    <img src="${escapedPath}" alt="${escapeHtml(label)} — ${escapeHtml(sampleId)}" loading="lazy" />
    <span>${escapeHtml(label)}</span>
  </a>`;
}

function promptDetails(title, request) {
  const prompt = request?.actual_tool_prompt || request?.rendered_prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return `<details><summary>${escapeHtml(title)}</summary><p class="missing">Точный tool prompt не найден.</p></details>`;
  }
  return `<details>
    <summary>${escapeHtml(title)}</summary>
    <pre>${escapeHtml(prompt)}</pre>
  </details>`;
}

function cardFor(sample) {
  const sampleId = sample.sample_id;
  if (typeof sampleId !== 'string' || !sampleId) fail('manifest has a sample without sample_id');
  const sampleDir = join(currentRunDir, 'samples', sampleId);
  if (!existsSync(sampleDir)) fail(`missing sample directory for ${sampleId}`);

  const source = readJson(join(sampleDir, '00-source.json'));
  const editorial = readOptionalJson(join(sampleDir, '01-editorial.result.json'))?.result || {};
  const visual = readOptionalJson(join(sampleDir, '02-visual-brief.result.json'))?.result || {};
  // r01 used a built-in-image-tool adapter request. v2 records the actual
  // application provider request directly. Keep the fallback so the immutable
  // r01 review remains inspectable with newer local tooling.
  const backgroundRequest = readOptionalJson(join(sampleDir, '03-background.imagegen.request.json'))
    || readOptionalJson(join(sampleDir, '03-background.request.json'));
  const compositionRequest = readOptionalJson(join(sampleDir, '04-composition.imagegen.request.json'))
    || readOptionalJson(join(sampleDir, '04-composition.request.json'));
  const backgroundResult = readOptionalJson(join(sampleDir, '03-background.result.json'));
  const compositionResult = readOptionalJson(join(sampleDir, '04-composition.result.json'));
  const sourceUrl = safeSourceUrl(source.source_url);
  const safeZone = visual?.composition?.text_safe_zone;
  const displayStatus = compositionResult?.status === 'generated'
    ? 'complete'
    : backgroundResult?.status === 'generated'
      ? 'background_generated'
      : sample.status || '—';

  const sourceLink = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a>`
    : '<span class="missing">Безопасный source_url не найден</span>';

  return `<article class="card" id="${escapeHtml(sampleId)}">
    <header>
      <span class="number">${escapeHtml(sampleId)}</span>
      <span class="status">${escapeHtml(displayStatus)}</span>
    </header>

    <section class="source">
      <h2>Источник</h2>
      <p>${sourceLink}</p>
      <p class="meta">${escapeHtml(source.author || '—')} · ${escapeHtml(source.text_source || '—')}</p>
    </section>

    <section>
      <h2>01 · Editorial</h2>
      <dl>
        <dt>Hook</dt><dd class="hook">${escapeHtml(text(editorial.hook))}</dd>
        <dt>Selected logline</dt><dd>${escapeHtml(text(editorial.selected_logline || editorial.dek))}</dd>
        ${Array.isArray(editorial.logline_candidates) ? `<dt>Model candidates</dt><dd>${editorial.logline_candidates.map((candidate, index) => `${index + 1}. ${escapeHtml(text(candidate))}`).join('<br />')}</dd>` : ''}
        <dt>Key idea</dt><dd>${escapeHtml(text(editorial.key_idea))}</dd>
      </dl>
    </section>

    <section>
      <h2>02 · Visual direction</h2>
      <dl>
        <dt>Scene</dt><dd>${escapeHtml(text(visual.scene))}</dd>
        <dt>Subject</dt><dd>${escapeHtml(text(visual.subject))}</dd>
        <dt>Action</dt><dd>${escapeHtml(text(visual.action))}</dd>
        <dt>Safe zone</dt><dd>${escapeHtml(text(safeZone))}</dd>
      </dl>
    </section>

    <section class="prompts">
      ${promptDetails('03 · Exact background image prompt', backgroundRequest)}
      ${promptDetails('04 · Exact composition image prompt', compositionRequest)}
    </section>

    <section class="images">
      ${imageBlock(sampleId, '03-background.png', '03 · Background')}
      ${imageBlock(sampleId, '04-composition.png', '04 · Composition')}
    </section>
  </article>`;
}

function promptSummary(prompts) {
  if (!Array.isArray(prompts) || prompts.length === 0) return '—';
  return prompts
    .map((prompt) => `${text(prompt.id)} ${text(prompt.version)}`)
    .map(escapeHtml)
    .join(' · ');
}

function documentFor(manifest) {
  const cards = manifest.samples.map(cardFor).join('\n');
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Instagram Cover Lab · ${escapeHtml(manifest.run_id)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101113; color: #f4f3ef; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #101113; color: #f4f3ef; }
    main { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 80px; }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 48px); letter-spacing: -0.04em; }
    h2 { margin: 0 0 12px; font-size: 15px; color: #bcb8ae; text-transform: uppercase; letter-spacing: 0.08em; }
    .summary { margin: 0 0 30px; color: #bcb8ae; line-height: 1.55; }
    .summary strong { color: #f4f3ef; }
    .grid { display: grid; gap: 20px; }
    .card { padding: 24px; border: 1px solid #2e3034; border-radius: 18px; background: #191a1e; box-shadow: 0 8px 24px rgba(0,0,0,.16); }
    .card > header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 22px; }
    .number { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; }
    .status { padding: 5px 9px; border-radius: 999px; color: #a7d8bc; background: #183527; font-size: 12px; }
    section { margin-top: 22px; }
    .source p { overflow-wrap: anywhere; }
    .meta, .missing { color: #a7a39b; font-size: 13px; }
    a { color: #92c5ff; }
    dl { display: grid; grid-template-columns: minmax(90px, 150px) 1fr; gap: 9px 16px; margin: 0; line-height: 1.5; }
    dt { color: #a7a39b; font-size: 13px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .hook { color: #fff4bf; font-size: 20px; font-weight: 700; line-height: 1.2; }
    details { margin-top: 10px; border: 1px solid #36383e; border-radius: 10px; background: #121316; }
    summary { padding: 12px 14px; cursor: pointer; color: #e3dfd5; }
    pre { margin: 0; padding: 0 14px 14px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: #d7d4cb; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .image { display: grid; gap: 8px; color: #d7d4cb; text-decoration: none; font-size: 13px; }
    .image img { display: block; width: 100%; border-radius: 12px; background: #292b30; aspect-ratio: 4 / 5; object-fit: cover; }
    .image:hover img { outline: 2px solid #92c5ff; }
    .image.missing { align-content: center; min-height: 180px; padding: 16px; border: 1px dashed #555; border-radius: 12px; }
    @media (max-width: 700px) { main { width: min(100% - 20px, 1280px); padding-top: 20px; } .card { padding: 18px; } dl { grid-template-columns: 1fr; gap: 4px; } dd { margin-bottom: 9px; } .images { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Instagram Cover Lab</h1>
    <p class="summary"><strong>Run:</strong> ${escapeHtml(manifest.run_id)}<br />
      <strong>Created:</strong> ${escapeHtml(manifest.created_at || '—')}<br />
      <strong>Samples:</strong> ${escapeHtml(String(manifest.samples.length))}<br />
      <strong>Prompt versions:</strong> ${promptSummary(manifest.prompts)}</p>
    <div class="grid">${cards}</div>
  </main>
</body>
</html>
`;
}

const [runId, ...optionArgs] = process.argv.slice(2);
if (!runId) fail('usage: node tools/build-review.mjs <run-id>');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(runId) || runId.includes('..')) {
  fail('run id must be a simple file-name component');
}

let outputName = 'review.html';
if (optionArgs.length) {
  if (optionArgs.length !== 2 || optionArgs[0] !== '--output') {
    fail('usage: node tools/build-review.mjs <run-id> [--output <filename.html>]');
  }
  outputName = optionArgs[1];
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(outputName) || outputName.includes('..')) {
  fail('output must be a relative basename ending in .html');
}

const currentRunId = runId;
const currentRunDir = resolve(RUNS_DIR, currentRunId);
if (dirname(currentRunDir) !== RUNS_DIR || !existsSync(currentRunDir)) {
  fail(`run not found: ${currentRunId}`);
}

const manifest = readJson(join(currentRunDir, 'manifest.json'));
if (!Array.isArray(manifest.samples) || manifest.samples.length !== 10) {
  fail('manifest must contain exactly ten samples');
}
if (manifest.run_id !== currentRunId) fail('manifest run_id does not match requested run id');

const outputPath = join(currentRunDir, outputName);
if (existsSync(outputPath)) fail(`will not overwrite existing ${outputPath}`);
writeFileSync(outputPath, documentFor(manifest), { encoding: 'utf8', flag: 'wx' });
console.log(`Created ${outputPath}`);
