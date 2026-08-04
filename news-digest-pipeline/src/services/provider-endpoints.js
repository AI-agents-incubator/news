// Provider credentials and article/prompt content must never be sent to an
// operator-supplied arbitrary host. The SDK defaults are safe when the value is
// empty; the only non-empty overrides supported by this product are the
// providers' canonical HTTPS API roots.
const OFFICIAL_ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
});

/** The canonical root used when configuration intentionally leaves it empty. */
export function officialProviderBaseUrl(vendor) {
  return OFFICIAL_ENDPOINTS[vendor] || null;
}

/**
 * Return a canonical approved base URL, an empty string (use SDK default), or
 * null when the value is not an approved provider endpoint.
 */
export function normalizeProviderBaseUrl(vendor, raw) {
  if (raw === '') return '';
  if (typeof raw !== 'string') return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // Credentials in the URL, alternate ports, query strings and fragments are
  // never meaningful for these SDK roots and make endpoint comparison unsafe.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) return null;

  if (vendor === 'openai') {
    if (url.hostname !== 'api.openai.com' || !['/v1', '/v1/'].includes(url.pathname)) return null;
    return OFFICIAL_ENDPOINTS.openai;
  }

  if (vendor === 'anthropic') {
    if (url.hostname !== 'api.anthropic.com' || !['', '/'].includes(url.pathname)) return null;
    return OFFICIAL_ENDPOINTS.anthropic;
  }

  return null;
}

/**
 * Parse a provider base URL from environment/configuration and fail closed.
 * Starting without a provider client is safer than leaking its API key to an
 * arbitrary endpoint through a malformed or tampered environment file.
 */
export function requireOfficialProviderBaseUrl(vendor, raw) {
  const normalized = normalizeProviderBaseUrl(vendor, raw);
  if (normalized === null) {
    throw new Error(`${vendor} base URL must be empty or its official HTTPS API endpoint`);
  }
  return normalized;
}
