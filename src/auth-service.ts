/**
 * Identity-vessel authentication: the org check.
 *
 * `resolveTenant` is the one call: POST {identity}/v1/auth/resolve with
 * `Authorization: ApiKey <key>` (identity-vessel's flat header form), which
 * answers `{ valid, org_id, user_id, key_id, jwt, jwt_expires_at }`, or 401 for a
 * key outside its namespace. The identity endpoint is the attachment's
 * (`src/attachment.ts` — explicit, or learned from /bootstrap); this module never
 * reads one from the environment. CONFORMANCE §c3-identity
 *
 * AuthService holds the resolved tenant for the process and runs the periodic
 * key-issuance heartbeat against that same identity.
 *
 * Env vars:
 *   METABOB_API_KEY   — the substrate key
 *   IDENTITY_API_KEY  — an extra key the loopback resolver accepts from local callers
 */

import { classifyNetError, netFetch, type NetInit } from './net.js';

const RESOLVE_TIMEOUT_MS = 5_000;
const BEARER_REFRESH_MARGIN_MS = 60_000;

export interface TenantIdentity {
  orgId: string;
  userId?: string;
  keyId?: string;
  /** Inline JWT from identity-vessel for vessel-to-vessel Bearer auth. */
  bearerToken?: string;
  bearerExpiresAt?: number;
}

/** The classified outcome of one org check. */
export type TenantResolution =
  | ({ kind: 'authenticated' } & TenantIdentity)
  | { kind: 'key_rejected'; status: number }
  /** Non-JSON or HTML: something other than identity-vessel answered. */
  | { kind: 'not_identity'; detail: string }
  /** No connection, a timeout, or a non-auth HTTP failure. */
  | { kind: 'unreachable'; detail: string };

// @anchor org-check
/** One org check against `endpoint` with `apiKey`. Never throws. */
export async function resolveTenant(
  endpoint: string,
  apiKey: string,
  fetchImpl: typeof fetch = netFetch(),
): Promise<TenantResolution> {
  let res: Response;
  try {
    // The org check asks; it changes nothing, so a reset connection is retried.
    res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/v1/auth/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${apiKey}` },
      body: '{}',
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS + 1_000),
      net: { timeoutMs: RESOLVE_TIMEOUT_MS, idempotent: true },
    } as NetInit);
  } catch (err) {
    // The detail starts with the named network cause (src/net.ts@classify-error).
    const named = classifyNetError(err);
    if (named) return { kind: 'unreachable', detail: named.line };
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'unreachable', detail: /abort|timeout|timed out/i.test(msg) ? `response_timeout: timed out after ${RESOLVE_TIMEOUT_MS}ms` : msg };
  }

  const text = await res.text().catch(() => '');
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  let payload: Record<string, unknown> | null = null;
  if (!contentType.includes('text/html') && !text.trimStart().startsWith('<')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    return { kind: 'not_identity', detail: `HTTP ${res.status}, ${contentType || 'no content-type'}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'key_rejected', status: res.status };
  }
  if (!res.ok) {
    return { kind: 'unreachable', detail: `HTTP ${res.status}` };
  }

  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const orgId = str(payload.org_id);
  if (payload.valid !== true || !orgId) {
    return { kind: 'not_identity', detail: 'the response carries no org_id' };
  }
  let bearerToken: string | undefined;
  let bearerExpiresAt: number | undefined;
  const jwt = str(payload.jwt);
  const expires = str(payload.jwt_expires_at);
  if (jwt && expires && !Number.isNaN(Date.parse(expires))) {
    bearerToken = jwt;
    bearerExpiresAt = Date.parse(expires);
  }
  return {
    kind: 'authenticated',
    orgId,
    userId: str(payload.user_id),
    keyId: str(payload.key_id),
    bearerToken,
    bearerExpiresAt,
  };
}

export class AuthService {
  private identity: TenantIdentity | null = null;
  private apiKey: string | undefined;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  /** The key accepted by the loopback resolver alongside METABOB_API_KEY. */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /** Run one org check and hold its tenant when it authenticates. */
  async resolveTenant(endpoint: string, apiKey: string, fetchImpl: typeof fetch = netFetch()): Promise<TenantResolution> {
    const r = await resolveTenant(endpoint, apiKey, fetchImpl);
    if (r.kind === 'authenticated') {
      const { kind: _kind, ...identity } = r;
      this.identity = identity;
    } else if (r.kind === 'key_rejected') {
      this.identity = null;
    }
    return r;
  }

  /**
   * The periodic key-issuance heartbeat: re-resolve against the attachment's
   * identity. Each call to /v1/auth/resolve is what identity-vessel uses to
   * monitor this key's usage. Cadence is independent of the JWT TTL.
   */
  startKeyHeartbeat(
    intervalMs: number,
    endpoint: string,
    apiKey: string,
    onResult: (r: TenantResolution) => void = () => {},
    fetchImpl: typeof fetch = netFetch(),
  ): void {
    this.stopKeyHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.resolveTenant(endpoint, apiKey, fetchImpl).then(onResult);
    }, intervalMs);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  stopKeyHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** API key the loopback resolver accepts besides METABOB_API_KEY. */
  getIdentityApiKey(): string | undefined {
    return process.env.IDENTITY_API_KEY ?? process.env.METABOB_API_KEY ?? this.apiKey;
  }

  /** Bearer JWT for vessel-to-vessel calls. */
  getBearerToken(): string | undefined {
    if (!this.identity?.bearerToken || !this.identity.bearerExpiresAt) return undefined;
    if (Date.now() >= this.identity.bearerExpiresAt - BEARER_REFRESH_MARGIN_MS) return undefined;
    return this.identity.bearerToken;
  }

  getOrgId(): string | undefined {
    return this.identity?.orgId;
  }

  isResolved(): boolean {
    return this.identity !== null;
  }
}
