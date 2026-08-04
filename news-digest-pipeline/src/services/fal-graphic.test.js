import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_GRAPHIC_DIMENSIONS,
  FAL_GRAPHIC_MODELS,
  extractFalUsage,
  generateFalGraphic,
} from './fal-graphic.js';

function falResult(overrides = {}) {
  return {
    requestId: 'fal-request-123',
    data: {
      images: [{
        url: 'https://v3b.fal.media/files/example/generated.png',
        content_type: 'image/png',
        width: 1080,
        height: 1350,
      }],
      ...overrides.data,
    },
    ...overrides,
  };
}

function fakeFal(result = falResult()) {
  return {
    config: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(result),
  };
}

describe('generateFalGraphic', () => {
  it('submits a model-authored background prompt verbatim with exact requested dimensions', async () => {
    const client = fakeFal();
    const prompt = 'Model-authored editorial background. No typography.';

    const output = await generateFalGraphic(
      { falKey: 'fal-test-key' },
      { prompt, width: 1080, height: 1350 },
      { falClient: client }
    );

    expect(client.config).toHaveBeenCalledWith({ credentials: 'fal-test-key' });
    expect(client.subscribe).toHaveBeenCalledWith(FAL_GRAPHIC_MODELS.background, {
      input: {
        prompt,
        image_size: { width: 1080, height: 1350 },
        num_images: 1,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        output_format: 'png',
      },
    });
    expect(output).toMatchObject({
      provider: 'fal.ai',
      model: FAL_GRAPHIC_MODELS.background,
      requestId: 'fal-request-123',
      request: {
        mode: 'background',
        prompt,
        dimensions: { width: 1080, height: 1350 },
        dimensionsApplied: true,
        backgroundImageUrl: null,
      },
      output: {
        url: 'https://v3b.fal.media/files/example/generated.png',
        file: null,
        contentType: 'image/png',
        width: 1080,
        height: 1350,
      },
      usage: {
        status: 'not_reported_by_provider',
        raw: 'unknown',
        inputTokens: 'unknown',
        outputTokens: 'unknown',
        totalTokens: 'unknown',
      },
    });
    expect(output.request.promptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses Recraft image-to-image only for a composition prompt plus a public background URL', async () => {
    const client = fakeFal();
    const backgroundImageUrl = 'https://v3b.fal.media/files/example/background.png';

    const output = await generateFalGraphic(
      { falKey: 'fal-test-key' },
      { mode: 'composition', prompt: 'Model-authored final composition.', backgroundImageUrl },
      { falClient: client }
    );

    expect(client.subscribe).toHaveBeenCalledWith(FAL_GRAPHIC_MODELS.composition, {
      input: {
        prompt: 'Model-authored final composition.',
        image_url: backgroundImageUrl,
      },
    });
    expect(output.request).toMatchObject({
      mode: 'composition',
      dimensions: DEFAULT_GRAPHIC_DIMENSIONS,
      dimensionsApplied: false,
      backgroundImageUrl,
    });
  });

  it('preserves a provider-reported usage payload without inventing tokens or cost', async () => {
    const reportedUsage = { billed_units: 1, total_cost: 0.08 };
    const client = fakeFal(falResult({ usage: reportedUsage }));

    const output = await generateFalGraphic(
      { falKey: 'fal-test-key' },
      { prompt: 'Model-authored prompt.' },
      { falClient: client }
    );

    expect(output.usage).toEqual({
      status: 'reported_by_provider',
      raw: reportedUsage,
      inputTokens: 'unknown',
      outputTokens: 'unknown',
      totalTokens: 'unknown',
    });
  });

  it('recognizes documented token fields when a provider result actually includes them', () => {
    expect(extractFalUsage({ data: { usage: {
      input_tokens: 12,
      output_tokens: 34,
      total_tokens: 46,
    } } })).toEqual({
      status: 'reported_by_provider',
      raw: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
    });
  });

  it('rejects unconfigured credentials without falling back to process.env', async () => {
    const client = fakeFal();
    const original = process.env.FAL_KEY;
    process.env.FAL_KEY = 'must-not-be-read';
    try {
      await expect(generateFalGraphic({}, { prompt: 'Prompt.' }, { falClient: client }))
        .rejects.toThrow(/config\.falKey/);
      expect(client.config).not.toHaveBeenCalled();
      expect(client.subscribe).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = original;
    }
  });

  it('rejects unsafe composition URLs and invalid dimensions before any provider call', async () => {
    const client = fakeFal();
    await expect(generateFalGraphic(
      { falKey: 'fal-test-key' },
      { mode: 'composition', prompt: 'Prompt.', backgroundImageUrl: 'http://127.0.0.1/admin' },
      { falClient: client }
    )).rejects.toThrow(/public HTTPS/i);
    await expect(generateFalGraphic(
      { falKey: 'fal-test-key' },
      { prompt: 'Prompt.', width: 4096, height: 1 },
      { falClient: client }
    )).rejects.toThrow(/width/i);
    expect(client.config).not.toHaveBeenCalled();
    expect(client.subscribe).not.toHaveBeenCalled();
  });

  it('fails closed when FAL returns no request id or image URL', async () => {
    await expect(generateFalGraphic(
      { falKey: 'fal-test-key' },
      { prompt: 'Prompt.' },
      { falClient: fakeFal(falResult({ requestId: '' })) }
    )).rejects.toThrow(/request ID/i);

    await expect(generateFalGraphic(
      { falKey: 'fal-test-key' },
      { prompt: 'Prompt.' },
      { falClient: fakeFal({ requestId: 'id', data: { images: [] } }) }
    )).rejects.toThrow(/output image URL/i);
  });
});
