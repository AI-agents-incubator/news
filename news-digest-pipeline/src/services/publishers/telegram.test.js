import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendTelegramChannelFooter,
  publishToTelegram,
  TELEGRAM_CHANNEL_ASSISTANT_FOOTER,
} from './telegram.js';

afterEach(() => vi.unstubAllGlobals());

describe('Telegram channel assistant footer', () => {
  it('states only the supported assistant invocation forms', () => {
    expect(TELEGRAM_CHANNEL_ASSISTANT_FOOTER).toContain('/ask ваш вопрос');
    expect(TELEGRAM_CHANNEL_ASSISTANT_FOOTER).toContain('/help');
    expect(TELEGRAM_CHANNEL_ASSISTANT_FOOTER).not.toContain('/ai');
    expect(TELEGRAM_CHANNEL_ASSISTANT_FOOTER).not.toContain('@alexkrol_moderation_bot');
  });

  it('appends the approved copy exactly once', () => {
    const once = appendTelegramChannelFooter('Основной текст');
    expect(once).toBe(`Основной текст\n\n${TELEGRAM_CHANNEL_ASSISTANT_FOOTER}`);
    expect(appendTelegramChannelFooter(once)).toBe(once);
  });

  it('sends the footer through the Bot API for a normal channel publication', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 77 } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(publishToTelegram('token', '-100123', 'Основной текст')).resolves.toEqual({
      messageId: 77,
      messageIds: [77],
      totalMessages: 1,
      complete: true,
    });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.chat_id).toBe('-100123');
    expect(payload.text).toBe(`Основной текст\n\n${TELEGRAM_CHANNEL_ASSISTANT_FOOTER}`);
  });

  it('keeps the one footer intact in the final chunk of a long full post', async () => {
    let messageId = 0;
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: ++messageId } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const content = 'д'.repeat(4090);

    await expect(publishToTelegram('token', '-100123', content)).resolves.toEqual({
      messageId: 1,
      messageIds: [1, 2],
      totalMessages: 2,
      complete: true,
    });

    const sent = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).text);
    expect(sent).toHaveLength(2);
    expect(sent.every((text) => text.length <= 4096)).toBe(true);
    expect(sent.join('')).toBe(`${content}\n\n${TELEGRAM_CHANNEL_ASSISTANT_FOOTER}`);
    expect(sent[0]).not.toContain(TELEGRAM_CHANNEL_ASSISTANT_FOOTER);
    expect(sent[1].endsWith(TELEGRAM_CHANNEL_ASSISTANT_FOOTER)).toBe(true);
  });

  it('returns explicit partial progress instead of accepting a truncated long post', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => ({
      json: async () => (++call === 1
        ? { ok: true, result: { message_id: 71 } }
        : { ok: false, description: 'temporary failure' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await publishToTelegram('token', '-100123', 'д'.repeat(4090));

    expect(result).toEqual({
      messageId: 71,
      messageIds: [71],
      totalMessages: 2,
      complete: false,
    });
  });

  it('resumes a long post at the requested missing chunk', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 72 } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const content = 'д'.repeat(4090);

    const result = await publishToTelegram('token', '-100123', content, { skipChunks: 1 });

    expect(result).toEqual({
      messageId: 72,
      messageIds: [72],
      totalMessages: 2,
      complete: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).text;
    expect(sent.endsWith(TELEGRAM_CHANNEL_ASSISTANT_FOOTER)).toBe(true);
  });
});
