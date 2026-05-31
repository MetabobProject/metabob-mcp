/**
 * Auth header migration to Bearer (mitigation #4).
 *
 * The Metabob client historically sent `Authorization: ApiKey <key>`. Per the
 * 2026-05 migration plan we now prefer `Authorization: Bearer <key>` and fall
 * back to `ApiKey` on 401 so we stay compatible with servers that haven't
 * yet been updated.
 *
 * Server-side `Bearer` acceptance for raw API keys is a separate follow-up:
 *   - repos/metabob-activity-api/src/services/auth.ts (validateApiKeyWithFallback)
 *   - identity-vessel /v1/auth/resolve
 *
 * Per-host fallback state is sticky: once we observe a host that rejected
 * Bearer, we send ApiKey for the remainder of the process to avoid burning
 * an extra round-trip on every request.
 */

const HOSTS_REQUIRING_LEGACY_SCHEME = new Set<string>();

export type AuthScheme = 'Bearer' | 'ApiKey';

export function preferredAuthScheme(host: string): AuthScheme {
  return HOSTS_REQUIRING_LEGACY_SCHEME.has(host) ? 'ApiKey' : 'Bearer';
}

export function markHostNeedsLegacyScheme(host: string): void {
  HOSTS_REQUIRING_LEGACY_SCHEME.add(host);
}

export function buildAuthHeader(apiKey: string, host: string): string {
  return `${preferredAuthScheme(host)} ${apiKey}`;
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface BearerCapableFetchOptions {
  url: string;
  apiKey: string;
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };
  fetchImpl?: typeof fetch;
}

/**
 * Wrap a single HTTP call with the Bearer-preferred, ApiKey-fallback policy.
 *
 * - Picks Bearer by default; if the host has previously rejected Bearer with
 *   a 401, jumps straight to ApiKey.
 * - On a 401 with Bearer, retries the request once with ApiKey and records
 *   the host so subsequent requests skip Bearer entirely.
 */
export async function fetchWithBearerFallback(
  opts: BearerCapableFetchOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = hostFromUrl(opts.url);
  const baseHeaders = { ...(opts.init.headers ?? {}) };
  const scheme = preferredAuthScheme(host);

  const firstAttemptHeaders = {
    ...baseHeaders,
    Authorization: `${scheme} ${opts.apiKey}`,
  };
  const response = await fetchImpl(opts.url, { ...opts.init, headers: firstAttemptHeaders });

  if (response.status !== 401 || scheme !== 'Bearer') return response;

  // Bearer rejected — try ApiKey once. We can't reuse the body of a streaming
  // request, so opts.init.body must be a string / Buffer / FormData snapshot,
  // which is true for every call site in this repo.
  markHostNeedsLegacyScheme(host);

  // Drain the failed response so its connection can be reused.
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }

  const fallbackHeaders = {
    ...baseHeaders,
    Authorization: `ApiKey ${opts.apiKey}`,
  };
  return fetchImpl(opts.url, { ...opts.init, headers: fallbackHeaders });
}

/** Test-only: reset legacy-scheme tracking. */
export function _resetAuthSchemeStateForTests(): void {
  HOSTS_REQUIRING_LEGACY_SCHEME.clear();
}
