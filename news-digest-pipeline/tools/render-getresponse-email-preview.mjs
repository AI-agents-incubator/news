#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { buildNewsletterEmail } from '../src/pro/services/email-newsletter.js';

const requestedPostId = process.argv[2] || null;
const baseUrl = String(process.env.BASE_URL || '').replace(/\/+$/, '');
const apiKey = process.env.API_SECRET_KEY || '';

if (!baseUrl || !apiKey) {
  throw new Error('BASE_URL and API_SECRET_KEY are required to read the operator source-post feed');
}

const response = await fetch(`${baseUrl}/api/source-posts`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
if (!response.ok) {
  throw new Error(`source-post read failed (HTTP ${response.status})`);
}

const posts = await response.json();
if (!Array.isArray(posts) || posts.length === 0) {
  throw new Error('source-post feed is empty');
}
const post = requestedPostId
  ? posts.find((candidate) => candidate.id === requestedPostId)
  : posts[0];
if (!post) {
  throw new Error(`source post ${requestedPostId} was not found`);
}

const imageFile = Array.isArray(post.image_files) && post.image_files.length
  ? post.image_files[0]
  : post.image_file;
const imageUrl = imageFile
  ? `${baseUrl}/post-images/${encodeURIComponent(imageFile)}`
  : null;
const artifact = buildNewsletterEmail({ text: post.text, imageUrl });
const outputDir = resolve('output/previews/getresponse-email-v1');
const htmlPath = resolve(outputDir, `${post.id}.html`);
const receiptPath = resolve(outputDir, `${post.id}.receipt.json`);

mkdirSync(outputDir, { recursive: true });
for (const path of [htmlPath, receiptPath]) {
  if (existsSync(path)) {
    throw new Error(`refusing to overwrite existing preview: ${path}`);
  }
}

writeFileSync(htmlPath, artifact.html, 'utf8');
writeFileSync(receiptPath, `${JSON.stringify({
  sourcePostId: post.id,
  sourceUrl: post.source_url || null,
  detectedAt: post.detected_at || null,
  subject: artifact.subject,
  imageUrl,
  contentSha256: artifact.contentSha256,
  templateVersion: artifact.templateVersion,
  instructionsVersion: artifact.instructionsVersion,
}, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ htmlPath, receiptPath, subject: artifact.subject }));
