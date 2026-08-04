import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../db/index.js';
import { handleGenerate, handleTelegramUpdate } from './telegram-bot.js';

const CONFIG = {
  telegramChatId: '42',
  telegramBotToken: 'test-token',
  articleThreshold: 1,
  maxArticlesPerDigest: 10,
  processingLeaseMs: 60_000,
};

let originalFetch;

beforeEach(() => {
  initDb(':memory:');
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function sentText() {
  const options = globalThis.fetch.mock.calls[0][1];
  return JSON.parse(options.body).text;
}

function sentTexts() {
  return globalThis.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).text);
}

describe('Telegram status and URL ingestion', () => {
  it('reports ready count and accepts URL-only ingestion without a runtime error', async () => {
    await handleTelegramUpdate({
      message: { chat: { id: 42 }, message_id: 7, text: 'https://www.perplexity.ai/page/telegram-ready-test' },
    }, CONFIG);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Всего новых: 1');
    expect(sentText()).not.toContain('Готово 1 статей');

    globalThis.fetch.mockClear();
    await handleTelegramUpdate({ message: { chat: { id: 42 }, text: '/status' } }, CONFIG);

    expect(sentText()).toContain('Готово к дайджесту: 0');
  });

  it('/generate truthfully stops after Phase 1 and returns the review run ID', async () => {
    const articles = Array.from({ length: 30 }, (_, index) => ({
      id: `article-${index + 1}`,
      processing_lease_id: 'lease-1',
    }));

    await handleGenerate('test-token', '42', CONFIG, {
      claimArticles: vi.fn().mockReturnValue(articles),
      getDatabase: vi.fn().mockReturnValue({}),
      generatePhase1: vi.fn().mockResolvedValue('run-123'),
      getReviewRun: vi.fn().mockReturnValue({ id: 'run-123', status: 'awaiting_review' }),
    });

    expect(sentTexts()).toEqual([
      '⏳ Этап 1: обработка 30 готовых статей...',
      '✅ Этап 1 завершён (30 статей). Проверьте новости в панели дайджеста. Run ID: run-123',
    ]);
    expect(sentTexts().join('\n')).not.toContain('Дайджест сгенерирован');
  });

  it('/generate reports a failed Phase 1 run without claiming a digest exists', async () => {
    const articles = Array.from({ length: 30 }, (_, index) => ({
      id: `article-${index + 1}`,
      processing_lease_id: 'lease-1',
    }));

    await handleGenerate('test-token', '42', CONFIG, {
      claimArticles: vi.fn().mockReturnValue(articles),
      getDatabase: vi.fn().mockReturnValue({}),
      generatePhase1: vi.fn().mockResolvedValue('run-failed'),
      getReviewRun: vi.fn().mockReturnValue({ id: 'run-failed', status: 'failed' }),
    });

    expect(sentTexts().at(-1)).toBe(
      '❌ Этап 1 завершился с ошибкой. Откройте проход в панели дайджеста. Run ID: run-failed'
    );
  });

  it('/generate reports an interrupted Phase 1 without claiming completion', async () => {
    const articles = Array.from({ length: 30 }, (_, index) => ({
      id: `attention-${index + 1}`,
      processing_lease_id: 'lease-attention',
    }));
    await handleGenerate('test-token', '42', CONFIG, {
      claimArticles: vi.fn().mockReturnValue(articles),
      getDatabase: vi.fn().mockReturnValue({}),
      generatePhase1: vi.fn().mockResolvedValue('run-attention'),
      getReviewRun: vi.fn().mockReturnValue({
        id: 'run-attention', status: 'phase1_attention_required',
      }),
    });

    expect(sentTexts().at(-1)).toContain('требует явного восстановления');
    expect(sentTexts().at(-1)).toContain('Run ID: run-attention');
    expect(sentTexts().join('\n')).not.toContain('Этап 1 завершён');
  });
});
