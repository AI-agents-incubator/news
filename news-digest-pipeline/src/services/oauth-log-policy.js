const OAUTH_CALLBACK_PATHS = new Set([
  '/ig-oauth/callback',
  '/api/oauth/threads/callback',
  '/api/oauth/threads/uninstall',
  '/api/oauth/threads/delete',
]);

// OAuth authorization codes are single-use credentials carried in the query
// string. Morgan logs the full request URL, so these callbacks must be skipped
// entirely rather than relying on later redaction.
export function skipOAuthCallbackLog(req) {
  return OAUTH_CALLBACK_PATHS.has(req?.path);
}
