#!/usr/bin/env node

import { createHash } from 'crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const { run, sample, step, image } = args;
if (!run || !sample || !['03-background', '04-composition'].includes(step) || !image) {
  throw new Error('usage: record-image.mjs --run <id> --sample <id> --step 03-background|04-composition --image <path>');
}
const dir = join(LAB, 'runs', run, 'samples', sample);
const requestPath = join(dir, `${step}.imagegen.request.json`);
const resultPath = join(dir, `${step}.result.json`);
if (!existsSync(requestPath) || !existsSync(image)) throw new Error('missing prepared request or generated image');
if (existsSync(resultPath)) throw new Error(`refusing to overwrite ${resultPath}`);
const rawName = `${step}.raw.png`;
const finalName = `${step}.png`;
const rawPath = join(dir, rawName);
const finalPath = join(dir, finalName);
if (existsSync(rawPath) || existsSync(finalPath)) throw new Error('refusing to overwrite image artifact');
copyFileSync(image, rawPath);
await sharp(rawPath).rotate().resize(1080, 1350, { fit: 'cover', position: 'centre' }).png().toFile(finalPath);
const bytes = readFileSync(finalPath);
const metadata = await sharp(finalPath).metadata();
const result = {
  schema_version: 'instagram-cover-lab.image-result.v1',
  step,
  status: 'generated',
  tool: 'built-in image_gen',
  tool_model: 'not exposed by tool',
  request_file: `${step}.imagegen.request.json`,
  request_sha256: createHash('sha256').update(readFileSync(requestPath)).digest('hex'),
  raw_file: rawName,
  output_file: finalName,
  mime: 'image/png',
  width: metadata.width,
  height: metadata.height,
  bytes: bytes.length,
  output_sha256: createHash('sha256').update(bytes).digest('hex'),
  generated_at: new Date().toISOString(),
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
