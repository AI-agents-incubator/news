import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import {
  updateArticleStatus,
  updateArticleCommentary,
  createDigest,
  updateDigest,
  assignArticlesToDigest,
  getDigests,
} from '../db/index.js';

const MAX_CONTENT_LENGTH = 3000;
const RETRY_ATTEMPTS = 3;
const INTER_CALL_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaudeWithRetry(client, params, attempt = 1) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    if (err?.status === 429 && attempt < RETRY_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[digest-generator] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${RETRY_ATTEMPTS})`);
      await sleep(delay);
      return callClaudeWithRetry(client, params, attempt + 1);
    }
    throw err;
  }
}

export async function generateDigest(db, articles, config) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const log = [];

  log.push(`Starting digest generation for ${articles.length} articles`);

  // Phase A: Generate commentary for each article
  for (const article of articles) {
    if (article.commentary) {
      log.push(`Skipping article ${article.id} — commentary already exists`);
      continue;
    }

    try {
      updateArticleStatus(article.id, 'processing');

      const contentTruncated = (article.content || '').slice(0, MAX_CONTENT_LENGTH);

      const userMessage = article.title
        ? `${article.title}\n\n${contentTruncated}`
        : contentTruncated;

      const response = await callClaudeWithRetry(client, {
        model: config.claudeModel,
        max_tokens: 512,
        system: config.commentaryPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const commentary = response.content[0]?.text || '';
      updateArticleCommentary(article.id, commentary);
      article.commentary = commentary;

      log.push(`Generated commentary for article ${article.id}: ${commentary.slice(0, 60)}...`);

      await sleep(INTER_CALL_DELAY_MS);
    } catch (err) {
      log.push(`Error generating commentary for article ${article.id}: ${err.message}`);
      updateArticleStatus(article.id, 'error');
      // Continue with other articles
    }
  }

  // Filter articles that have commentary
  const articlesWithCommentary = articles.filter((a) => a.commentary);

  if (articlesWithCommentary.length === 0) {
    throw new Error('No articles with commentary — cannot assemble digest');
  }

  // Phase B: Assembly
  const today = new Date().toISOString().slice(0, 10);

  // Build the user message for assembly
  const commentaryList = articlesWithCommentary
    .map((a, i) => `${i + 1}. ${a.commentary}\n${a.url}`)
    .join('\n\n');

  const assemblyUserMessage = [
    `Вот ${articlesWithCommentary.length} обработанных комментариев для сборки в дайджест:`,
    '',
    commentaryList,
    '',
    '---',
    `Упоминание курса (вставить в середине списка): ${config.courseMention}`,
    '',
    `Граница/дисклеймер (в конце): ${config.boundaryIntent}`,
    '',
    `Хэштеги (в самом конце): ${config.hashtagsSuffix}`,
  ].join('\n');

  log.push('Assembling digest...');

  const assemblyResponse = await callClaudeWithRetry(client, {
    model: config.claudeModel,
    max_tokens: 16384,
    system: config.assemblyPrompt,
    messages: [{ role: 'user', content: assemblyUserMessage }],
  });

  const digestContent = assemblyResponse.content[0]?.text || '';

  // Create digest record
  const digestId = createDigest({
    date: today,
    part: 1,
    articlesCount: articlesWithCommentary.length,
  });

  updateDigest(digestId, {
    content: digestContent,
    status: 'draft',
    generation_log: log.join('\n'),
  });

  // Assign articles to digest
  const articleIds = articlesWithCommentary.map((a) => a.id);
  assignArticlesToDigest(articleIds, digestId);

  // Save digest as .txt file
  const filePath = saveDigestToFile(today, digestContent);
  log.push(`Digest saved to file: ${filePath}`);
  log.push(`Digest created: ${digestId}`);

  return digestId;
}

function saveDigestToFile(date, content) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = join(__dirname, '../../output');
  mkdirSync(outputDir, { recursive: true });

  // Determine part number based on existing files for this date
  const existing = getDigests().filter((d) => d.date === date);
  const part = existing.length || 1;

  const filename = `digest_${date}_part${part}.txt`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  console.log(`[digest-generator] Saved digest to ${filePath}`);
  return filePath;
}
