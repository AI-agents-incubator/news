import { describe, it, expect } from 'vitest';
import { classifyLlmError } from './llm.js';

// Shapes mirror what the SDKs actually throw: API errors carry `status` (both
// Anthropic and OpenAI SDKs), local config errors are plain Errors, network
// errors carry a code/message. The measured incident (deploy without
// OPENAI_API_KEY → synchronous throw, 25 comments failed in one second) MUST
// classify as permanent/config.

const mk = (message, extra = {}) => Object.assign(new Error(message), extra);

describe('classifyLlmError — permanent (a human must fix config)', () => {
  it('missing vendor key (our own synchronous throw) → config', () => {
    expect(classifyLlmError(mk('OpenAI API key не настроен (.env: OPENAI_API_KEY)')))
      .toEqual({ kind: 'config', permanent: true });
  });

  it('401/403 → auth', () => {
    expect(classifyLlmError(mk('Incorrect API key provided', { status: 401 })).kind).toBe('auth');
    expect(classifyLlmError(mk('forbidden', { status: 403 }))).toEqual({ kind: 'auth', permanent: true });
  });

  it('404 (typo in model id / model override) → model_not_found', () => {
    expect(classifyLlmError(mk('The model `gpt-5.6-tera` does not exist', { status: 404 })))
      .toEqual({ kind: 'model_not_found', permanent: true });
  });

  it('400 invalid request → bad_request', () => {
    expect(classifyLlmError(mk('Unsupported parameter', { status: 400 })).permanent).toBe(true);
  });

  it('429 with insufficient_quota (OpenAI exhausted balance) → quota, NOT rate_limit', () => {
    expect(classifyLlmError(mk('You exceeded your current quota', { status: 429, code: 'insufficient_quota' })))
      .toEqual({ kind: 'quota', permanent: true });
    expect(classifyLlmError(mk('insufficient_quota', { status: 429, error: { code: 'insufficient_quota' } })).kind)
      .toBe('quota');
  });
});

describe('classifyLlmError — transient (retries will heal it)', () => {
  it('plain 429 → rate_limit', () => {
    expect(classifyLlmError(mk('Rate limit reached', { status: 429 })))
      .toEqual({ kind: 'rate_limit', permanent: false });
  });

  it('5xx → server', () => {
    expect(classifyLlmError(mk('Internal server error', { status: 500 })).kind).toBe('server');
    expect(classifyLlmError(mk('overloaded', { status: 529 })).permanent).toBe(false);
  });

  it('network errors (ECONNRESET / fetch failed / ETIMEDOUT) → network', () => {
    expect(classifyLlmError(mk('read ECONNRESET', { code: 'ECONNRESET' })).kind).toBe('network');
    expect(classifyLlmError(mk('fetch failed')).kind).toBe('network');
    expect(classifyLlmError(mk('connect ETIMEDOUT 1.2.3.4:443')).kind).toBe('network');
    expect(classifyLlmError(mk('Connection error.')).kind).toBe('network');
  });

  it('anything unrecognized → unknown/transient (retry is the safe default)', () => {
    expect(classifyLlmError(mk('весёлая новая ошибка'))).toEqual({ kind: 'unknown', permanent: false });
    expect(classifyLlmError(null)).toEqual({ kind: 'unknown', permanent: false });
  });
});

describe('classifyLlmError — Anthropic no-credentials path', () => {
  it('SDK "Could not resolve authentication method" → config/permanent', () => {
    expect(classifyLlmError(mk('Could not resolve authentication method. Expected either apiKey or authToken to be set.')))
      .toEqual({ kind: 'config', permanent: true });
  });
  it('our anthropic pre-check message → config/permanent', () => {
    expect(classifyLlmError(mk('Anthropic API key не настроен (.env: ANTHROPIC_API_KEY)')))
      .toEqual({ kind: 'config', permanent: true });
  });
});
