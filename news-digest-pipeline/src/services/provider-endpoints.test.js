import { describe, it, expect } from 'vitest';
import {
  normalizeProviderBaseUrl,
  requireOfficialProviderBaseUrl,
} from './provider-endpoints.js';

describe('provider endpoint policy', () => {
  it('accepts empty values and normalizes official SDK roots', () => {
    expect(normalizeProviderBaseUrl('openai', '')).toBe('');
    expect(normalizeProviderBaseUrl('openai', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normalizeProviderBaseUrl('anthropic', 'https://api.anthropic.com/')).toBe('https://api.anthropic.com');
  });

  it('rejects arbitrary, insecure and credential-bearing endpoints', () => {
    for (const value of [
      'http://api.openai.com/v1',
      'https://proxy.example/v1',
      'https://api.openai.com.evil.example/v1',
      'https://key@api.openai.com/v1',
      'https://api.anthropic.com/v1',
    ]) {
      expect(normalizeProviderBaseUrl('openai', value), value).toBeNull();
    }
    expect(normalizeProviderBaseUrl('anthropic', 'https://proxy.example')).toBeNull();
  });

  it('fails closed for invalid environment configuration', () => {
    expect(() => requireOfficialProviderBaseUrl('openai', 'https://proxy.example/v1')).toThrow(/official HTTPS/i);
  });
});
