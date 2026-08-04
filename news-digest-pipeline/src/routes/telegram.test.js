import { describe, expect, it } from 'vitest';
import router from './telegram.js';

describe('Telegram editorial router', () => {
  it('exposes only the News editorial intake webhook', () => {
    const paths = router.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);

    expect(paths).toEqual(['/webhook']);
  });
});
