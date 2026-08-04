import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_GRAPHIC_DIMENSIONS,
  OPENAI_GRAPHIC_MODEL,
  generateOpenAiGraphic,
} from './openai-graphic.js';

const b64Json = Buffer.from('synthetic-image').toString('base64');

describe('OpenAI graphic adapter', () => {
  it('uses the Image API with an image-native portrait request and retains the provider request id', async () => {
    const generate = vi.fn(async () => ({
      _request_id: 'req-image-1',
      data: [{ b64_json: b64Json }],
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
    }));
    const client = { images: { generate } };

    const result = await generateOpenAiGraphic({ openaiApiKey: 'secret' }, {
      prompt: 'A carefully composed editorial image with no text.',
    }, { client });

    expect(generate).toHaveBeenCalledWith({
      model: OPENAI_GRAPHIC_MODEL,
      prompt: 'A carefully composed editorial image with no text.',
      n: 1,
      size: `${OPENAI_GRAPHIC_DIMENSIONS.width}x${OPENAI_GRAPHIC_DIMENSIONS.height}`,
      quality: 'medium',
      output_format: 'jpeg',
      output_compression: 95,
      background: 'opaque',
    });
    expect(result).toMatchObject({
      provider: 'openai', model: OPENAI_GRAPHIC_MODEL, requestId: 'req-image-1',
      output: { b64Json, contentType: 'image/jpeg', width: 1024, height: 1280 },
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    });
  });

  it('fails before any provider call when the OpenAI credential or response receipt is absent', async () => {
    const generate = vi.fn();
    await expect(generateOpenAiGraphic({}, { prompt: 'x' }, { client: { images: { generate } } }))
      .rejects.toThrow(/config\.openaiApiKey/);
    expect(generate).not.toHaveBeenCalled();

    await expect(generateOpenAiGraphic({ openaiApiKey: 'secret' }, { prompt: 'valid prompt' }, {
      client: { images: { generate: async () => ({ data: [{ b64_json: b64Json }] }) } },
    })).rejects.toThrow(/request ID/);
  });

  it('rejects a non-conforming OpenAI size before calling the provider', async () => {
    const generate = vi.fn();
    await expect(generateOpenAiGraphic({ openaiApiKey: 'secret' }, {
      prompt: 'valid prompt', width: 1080, height: 1350,
    }, { client: { images: { generate } } })).rejects.toThrow(/multiples of 16/);
    expect(generate).not.toHaveBeenCalled();
  });
});
