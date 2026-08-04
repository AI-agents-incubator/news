import { describe, it, expect } from 'vitest';
import { validatePatch } from './settings.js';

describe('settings provider endpoint validation', () => {
  it('accepts only canonical official endpoints and writes their normalized form', () => {
    const result = validatePatch({
      openaiBaseUrl: 'https://api.openai.com/v1/',
      anthropicBaseUrl: 'https://api.anthropic.com/',
    });

    expect(result.errors).toEqual([]);
    expect(result.env).toMatchObject({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
  });

  it('rejects a custom provider host before it can be persisted', () => {
    const result = validatePatch({ openaiBaseUrl: 'https://proxy.example/v1' });
    expect(result.env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(result.errors.join(' ')).toMatch(/official HTTPS endpoint|официальный HTTPS endpoint/i);
  });
});
