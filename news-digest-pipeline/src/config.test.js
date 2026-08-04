import { describe, expect, it } from 'vitest';
import { parseConfigMd } from './config.js';

describe('parseConfigMd', () => {
  it('keeps only literal footer copy and separates trailing hashtags', () => {
    const parsed = parseConfigMd(`## Граница\nВставлять ДОСЛОВНО, без изменений:\n\nТочный подвал\n\nдобавлять в конце поста хештеги:\n\n#one #two`);
    expect(parsed.boundaryIntent).toBe('Точный подвал');
    expect(parsed.hashtagsSuffix).toBe('#one #two');
  });

  it('supports a separately headed literal footer and hashtags block', () => {
    const parsed = parseConfigMd(`## Граница (отписка/бан)\n\n## Вставлять ДОСЛОВНО, без изменений:\n\nТочный подвал\n\n## Вставлять хештеги\n\n#one #two`);
    expect(parsed.boundaryIntent).toBe('Точный подвал');
    expect(parsed.hashtagsSuffix).toBe('#one #two');
  });
});
