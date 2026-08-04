#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, '..');
const runId = process.argv[2];
if (!runId) throw new Error('usage: node prepare-imagegen-prompts.mjs <run-id>');
const runDir = join(LAB, 'runs', runId);
if (!existsSync(join(runDir, 'manifest.json'))) throw new Error(`unknown run ${runId}`);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const adapter = (name) => ({
  file: `prompts/${name}`,
  text: readFileSync(join(LAB, 'prompts', name), 'utf8'),
});
const backgroundAdapter = adapter('background-imagegen-adapter.v1.md');
const compositionAdapter = adapter('cover-composition-imagegen-adapter.v1.md');
const run = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));

for (const sample of run.samples) {
  if (sample.status !== 'text_stages_complete') continue;
  const dir = join(runDir, 'samples', sample.sample_id);
  const background = JSON.parse(readFileSync(join(dir, '03-background.request.json'), 'utf8'));
  const composition = JSON.parse(readFileSync(join(dir, '04-composition.request.json'), 'utf8'));
  const backgroundPrompt = backgroundAdapter.text.replace('{{BACKGROUND_PROMPT}}', background.rendered_prompt);
  const compositionPrompt = compositionAdapter.text.replace('{{COMPOSITION_PROMPT}}', composition.rendered_prompt);
  for (const [step, prompt, source, adapterMeta] of [
    ['03-background', backgroundPrompt, background, backgroundAdapter],
    ['04-composition', compositionPrompt, composition, compositionAdapter],
  ]) {
    const artifact = {
      schema_version: 'instagram-cover-lab.imagegen-request.v1',
      step,
      status: 'prepared',
      base_request: step === '03-background' ? '03-background.request.json' : '04-composition.request.json',
      base_rendered_prompt_sha256: source.rendered_prompt_sha256,
      adapter_prompt: { file: adapterMeta.file, sha256: sha(adapterMeta.text) },
      actual_tool_prompt: prompt,
      actual_tool_prompt_sha256: sha(prompt),
      tool: 'built-in image_gen',
    };
    writeFileSync(join(dir, `${step}.imagegen.request.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  }
}
console.log('PREPARED');
