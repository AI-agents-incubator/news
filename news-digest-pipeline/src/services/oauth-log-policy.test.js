import { describe, expect, it } from 'vitest';
import { skipOAuthCallbackLog } from './oauth-log-policy.js';

describe('OAuth request log policy', () => {
  it('suppresses both Instagram and Threads callback requests', () => {
    expect(skipOAuthCallbackLog({ path: '/ig-oauth/callback' })).toBe(true);
    expect(skipOAuthCallbackLog({ path: '/api/oauth/threads/callback' })).toBe(true);
    expect(skipOAuthCallbackLog({ path: '/api/oauth/threads/uninstall' })).toBe(true);
    expect(skipOAuthCallbackLog({ path: '/api/oauth/threads/delete' })).toBe(true);
  });

  it('keeps normal request logging enabled', () => {
    expect(skipOAuthCallbackLog({ path: '/health' })).toBe(false);
    expect(skipOAuthCallbackLog({ path: '/api/source-posts' })).toBe(false);
  });
});
