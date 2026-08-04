import { describe, expect, it } from 'vitest';
import { parseEditorialV2, usageRecord, USAGE_NOT_REPORTED } from './contracts.mjs';

const validEditorial = {
  key_idea: 'Регулятор вводит новые правила для рынка.',
  hook: 'Новые правила меняют рынок',
  logline_candidates: [
    'Изменения задают новые требования для участников рынка.',
    'Новые требования влияют на условия работы компаний.',
    'Рынок переходит на правила с дополнительными ограничениями.',
  ],
  selected_logline_index: 1,
  selected_logline: 'Новые требования влияют на условия работы компаний.',
  factual_anchor: 'Источник описывает введение новых требований.',
  facts_used: ['Вводятся новые требования.'],
};

describe('editorial-card.v2 contract', () => {
  it('accepts three model candidates and an exact model selection', () => {
    expect(parseEditorialV2(JSON.stringify(validEditorial))).toEqual(validEditorial);
  });

  it('rejects a selection not returned in the model candidate array', () => {
    expect(() => parseEditorialV2(JSON.stringify({
      ...validEditorial,
      selected_logline: 'Эта строка не была предложена моделью.',
    }))).toThrow(/exactly equal/);
  });

  it('rejects a contract with a manual extra field', () => {
    expect(() => parseEditorialV2(JSON.stringify({ ...validEditorial, manual_logline: 'нет' })))
      .toThrow(/does not match/);
  });

  it('rejects forbidden author-or-post meta-language in a candidate', () => {
    expect(() => parseEditorialV2(JSON.stringify({
      ...validEditorial,
      logline_candidates: [
        'Автор сообщает о новых требованиях для участников рынка.',
        validEditorial.logline_candidates[1],
        validEditorial.logline_candidates[2],
      ],
      selected_logline_index: 1,
      selected_logline: validEditorial.logline_candidates[1],
    }))).toThrow(/meta-language/);
  });
});

describe('usage ledger contract', () => {
  it('keeps missing provider token accounting explicit instead of zero', () => {
    const record = usageRecord({
      runId: 'run-1', sampleId: 'sample-1', step: '03-background', attempt: 1,
      provider: 'fal', model: 'fal-ai/flux/dev', reasoningEffort: null, promptSha256: 'a'.repeat(64),
      usage: { input_tokens: USAGE_NOT_REPORTED, output_tokens: USAGE_NOT_REPORTED, total_tokens: USAGE_NOT_REPORTED },
      status: 'succeeded', at: '2026-07-20T00:00:00.000Z', requestId: 'request-1',
    });
    expect(record.input_tokens).toBe(USAGE_NOT_REPORTED);
    expect(record.output_tokens).toBe(USAGE_NOT_REPORTED);
    expect(record.total_tokens).toBe(USAGE_NOT_REPORTED);
  });
});
