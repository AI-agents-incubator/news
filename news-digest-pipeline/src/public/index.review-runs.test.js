import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

describe('digest review dashboard contract', () => {
  it('keeps the shared navigation unchanged and makes Обработка the first local panel', () => {
    expect(html).toContain('<a class="tab" href="syndication.html">Публикация</a>');
    expect(html.indexOf('id="digest-tab-processing"')).toBeLessThan(html.indexOf('id="digest-tab-list"'));
    expect(html).toContain('class="digest-panel active" id="digest-panel-processing"');
    expect(html).toContain('class="digest-panel" id="digest-panel-list"');
  });

  it('exposes per-run settings, Phase 1 inspection, exclusion, rerun, and explicit Phase 2 controls', () => {
    expect(html).toContain('id="review-source-max-chars"');
    expect(html).toContain('value="6000"');
    expect(html).toContain('id="review-comment-min"');
    expect(html).toContain('value="80"');
    expect(html).toContain('id="review-comment-max"');
    expect(html).toContain('value="150"');
    expect(html).toContain('id="review-phase1-model"');
    expect(html).toContain('id="review-phase2-model"');
    expect(html).toContain("const efforts = [...new Set(['', 'minimal', ...configuredEfforts])]");
    expect(html).toContain('id="review-phase1-prompt"');
    expect(html).toContain('id="review-phase2-prompt"');
    expect(html).toContain('<details class="review-settings">');
    expect(html).not.toContain('<details class="review-settings" open>');
    expect(html).toContain('class="review-secondary review-show"');
    expect(html).toContain('class="review-toggle review-mutation');
    expect(html).toContain("isIncluded ? 'Выключить' : 'Включить'");
    expect(html).toContain('Собрать дайджест из ${included}');
    expect(html).toContain('Повторить');
    expect(html).toContain('id="review-recover-phase1"');
    expect(html).toContain('id="review-retry-phase2"');
    expect(html).toContain('id="review-recover-phase2"');
    expect(html).toContain("run.status === 'phase2_retryable' && Number(run.phase2_attempt_count || 0) === 0");
    expect(html).toContain("data-action=\"retry\"");
    expect(html).toContain('неоднозначен — повтор заблокирован');
  });

  it('uses only digest review-run endpoints and keeps all mutations read-only aware', () => {
    expect(html).toContain('/api/digests/review-runs/options');
    expect(html).toContain('/api/digests/review-runs/from-digest/');
    expect(html).toContain('/assemble`');
    expect(html).toContain('/recover-phase1`');
    expect(html).toContain('/resolve-phase1`');
    expect(html).toContain('/retry-phase2`');
    expect(html).toContain('/recover-phase2`');
    expect(html).toContain('body.readonly .review-mutation');
    expect(html).toContain('if (READONLY) return;');
  });
});
