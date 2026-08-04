import { describe, it, expect, vi, afterEach } from 'vitest';

// The per-call reasoning-effort override exists because reasoning tokens are billed
// as OUTPUT. Prod runs OPENAI_REASONING_EFFORT=medium account-wide; a classifier that
// emits one word would inherit it and pay for hundreds of hidden tokens per call —
// the same mechanism that produced the empty-answer incident (event 896dfb73:
// output_tokens=500, all reasoning, visible text empty).
//
// We assert on the REQUEST the OpenAI SDK receives, since that is the contract.

const createMock = vi.fn();
const openAiConstructorMock = vi.fn();
vi.mock('openai', () => ({
  default: class {
    constructor(options) {
      openAiConstructorMock(options);
      this.chat = { completions: { create: createMock } };
    }
  },
}));

const { callModel } = await import('./llm.js');

const config = {
  llmVendor: 'openai',
  openaiApiKey: 'test-key',
  claudeModel: 'gpt-5.6-terra',
  openaiReasoningEffort: 'medium', // account-wide default, as on prod
};

const okResponse = {
  choices: [{ message: { content: 'content' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

const lastRequest = () => createMock.mock.calls[createMock.mock.calls.length - 1][0];

afterEach(() => {
  createMock.mockReset();
  openAiConstructorMock.mockReset();
});

describe('callModel — reasoning effort resolution', () => {
  it('keeps the legacy text-only user message as a string', async () => {
    createMock.mockResolvedValue(okResponse);
    await callModel(config, { system: 's', user: 'text-only question', maxTokens: 100 });
    expect(lastRequest().messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'text-only question' },
    ]);
  });

  it('adds one low-detail image to the existing OpenAI Chat Completions user message', async () => {
    createMock.mockResolvedValue(okResponse);
    await callModel(config, {
      system: 's', user: 'what is shown?', maxTokens: 100,
      image: { dataUrl: 'data:image/jpeg;base64,AA==' },
    });
    expect(lastRequest().messages).toEqual([
      { role: 'system', content: 's' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is shown?' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==', detail: 'low' } },
        ],
      },
    ]);
  });

  it('without an override, inherits the account-wide setting', async () => {
    createMock.mockResolvedValue(okResponse);
    await callModel(config, { system: 's', user: 'u', maxTokens: 100 });
    expect(lastRequest().reasoning_effort).toBe('medium');
  });

  it('a per-call override wins over the account-wide setting', async () => {
    createMock.mockResolvedValue(okResponse);
    await callModel(config, { system: 's', user: 'u', maxTokens: 8, reasoningEffort: 'minimal' });
    expect(lastRequest().reasoning_effort).toBe('minimal');
  });

  it("'none' strips the parameter entirely — the classifier opts out", async () => {
    createMock.mockResolvedValue(okResponse);
    await callModel(config, { system: 's', user: 'u', maxTokens: 8, reasoningEffort: 'none' });
    expect(lastRequest()).not.toHaveProperty('reasoning_effort');
  });

  it('an unset account default plus no override sends no parameter', async () => {
    createMock.mockResolvedValue(okResponse);
    await callModel({ ...config, openaiReasoningEffort: '' }, { system: 's', user: 'u', maxTokens: 100 });
    expect(lastRequest()).not.toHaveProperty('reasoning_effort');
  });

  it('uses the explicit official endpoint instead of an SDK environment override', async () => {
    createMock.mockResolvedValue(okResponse);
    const original = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = 'https://proxy.example/v1';
      await callModel({ ...config, openaiBaseUrl: '' }, { system: 's', user: 'u', maxTokens: 100 });
      expect(openAiConstructorMock).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'https://api.openai.com/v1',
      }));
    } finally {
      if (original === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = original;
    }
  });

  it('a model rejecting reasoning_effort still gets its answer (parameter dropped, call retried)', async () => {
    createMock
      .mockRejectedValueOnce(Object.assign(new Error('Unsupported parameter: reasoning_effort'), { status: 400 }))
      .mockResolvedValueOnce(okResponse);
    const res = await callModel(config, { system: 's', user: 'u', maxTokens: 8, reasoningEffort: 'minimal' });
    expect(res.text).toBe('content');
    expect(lastRequest()).not.toHaveProperty('reasoning_effort');
  });
});
