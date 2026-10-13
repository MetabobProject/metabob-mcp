/**
 * Identity-vessel authentication: POST /v1/auth/resolve with the impulse form
 * resolves the key's orgId/userId and captures an inline JWT.
 *
 * It runs only against an explicit identity endpoint (IDENTITY_ENDPOINT or
 * metabob.identityEndpoint); there is no default host, and without one tenant
 * resolution is skipped. CONFORMANCE §c4-anchoring
 *
 * Env vars:
 *   METABOB_API_KEY   — the substrate key
 *   IDENTITY_API_KEY  — a separate identity key; falls back to METABOB_API_KEY
 *   IDENTITY_ENDPOINT — the identity vessel (no default)
 */

const RESOLVE_TIMEOUT_MS = 5_000;
const BEARER_REFRESH_MARGIN_MS = 60_000;

export interface TenantIdentity {
  orgId: string;
  userId?: string;
  /** Inline JWT from identity-vessel for vessel-to-vessel Bearer auth. */
  bearerToken?: string;
  bearerExpiresAt?: number;
}

type AuthState =
  | { status: 'unauthenticated' }
  | { status: 'resolved'; identity: TenantIdentity; apiKey: string }
  | { status: 'key_only'; apiKey: string };

export class AuthService {
  private state: AuthState = { status: 'unauthenticated' };
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  /** Set the identity API key and mark as key_only until tenant resolves. */
  setApiKey(apiKey: string): void {
    this.state = { status: 'key_only', apiKey };
  }

  /**
   * Resolve tenant from identity-vessel.
   * Non-fatal — on failure the service stays in key_only state.
   */
  async resolveTenant(endpoint?: string): Promise<void> {
    const apiKey = this.getIdentityApiKey();
    const base = endpoint ?? process.env.IDENTITY_ENDPOINT;
    if (!apiKey || !base) return;

    const url = `${base}/v1/auth/resolve`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          impulse: {
            type: 'authentication',
            pointer: { type: 'apiKey', apiKey },
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.error(`[auth-service] identity-vessel returned HTTP ${res.status}`);
        return;
      }

      const payload = await res.json().catch(() => null) as {
        success?: boolean;
        data?: {
          authenticated?: boolean;
          orgId?: string; org_id?: string;
          userId?: string; user_id?: string;
          jwt?: string;
          jwt_expires_at?: string; jwtExpiresAt?: string;
        };
      } | null;

      const data = payload?.data;
      if (!data?.authenticated) {
        console.error('[auth-service] identity-vessel: not authenticated');
        return;
      }

      const orgId = data.orgId ?? data.org_id;
      const userId = data.userId ?? data.user_id;
      if (!orgId) {
        console.error('[auth-service] identity-vessel: no orgId in response');
        return;
      }

      let bearerToken: string | undefined;
      let bearerExpiresAt: number | undefined;
      const jwtExpiresIso = data.jwt_expires_at ?? data.jwtExpiresAt;
      if (data.jwt && jwtExpiresIso) {
        const parsed = Date.parse(jwtExpiresIso);
        if (!Number.isNaN(parsed)) {
          bearerToken = data.jwt;
          bearerExpiresAt = parsed;
        }
      }

      this.state = {
        status: 'resolved',
        apiKey,
        identity: { orgId, userId, bearerToken, bearerExpiresAt },
      };

      console.error(
        `[auth-service] tenant resolved: orgId=${orgId}${userId ? ` userId=${userId}` : ''}${bearerToken ? ' (inline JWT captured)' : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('AbortError')) {
        console.error(`[auth-service] tenant resolution timed out after ${RESOLVE_TIMEOUT_MS}ms`);
      } else {
        console.error(`[auth-service] tenant resolution failed: ${msg}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshTenant(endpoint?: string): Promise<void> {
    return this.resolveTenant(endpoint);
  }

  /**
   * Start a periodic re-resolve loop against identity-vessel.
   *
   * Each call to /v1/auth/resolve is the key-issuance heartbeat that
   * identity-vessel uses to monitor metabob-mcp usage during the interim
   * period. Cadence is independent of the JWT TTL.
   */
  startKeyHeartbeat(intervalMs = 5 * 60_000, endpoint?: string): void {
    this.stopKeyHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.resolveTenant(endpoint).catch(() => {
        // resolveTenant logs its own errors
      });
    }, intervalMs);
    if (typeof (this.heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (this.heartbeatTimer as { unref: () => void }).unref();
    }
  }

  stopKeyHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** API key to use against the identity vessel. */
  getIdentityApiKey(): string | undefined {
    const key = process.env.IDENTITY_API_KEY ?? process.env.METABOB_API_KEY;
    if (key) return key;
    if (this.state.status !== 'unauthenticated') return this.state.apiKey;
    return undefined;
  }

  /** Bearer JWT for vessel-to-vessel calls. */
  getBearerToken(): string | undefined {
    if (this.state.status !== 'resolved') return undefined;
    const { bearerToken, bearerExpiresAt } = this.state.identity;
    if (!bearerToken || !bearerExpiresAt) return undefined;
    if (Date.now() >= bearerExpiresAt - BEARER_REFRESH_MARGIN_MS) return undefined;
    return bearerToken;
  }

  bearerTokenIsStale(): boolean {
    if (this.state.status !== 'resolved') return false;
    const { bearerToken, bearerExpiresAt } = this.state.identity;
    if (!bearerToken || !bearerExpiresAt) return false;
    return Date.now() >= bearerExpiresAt - BEARER_REFRESH_MARGIN_MS;
  }

  getOrgId(): string | undefined {
    return this.state.status === 'resolved' ? this.state.identity.orgId : undefined;
  }

  getUserId(): string | undefined {
    return this.state.status === 'resolved' ? this.state.identity.userId : undefined;
  }

  isResolved(): boolean {
    return this.state.status === 'resolved';
  }

  hasKey(): boolean {
    return this.state.status !== 'unauthenticated';
  }
}

let _instance: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!_instance) _instance = new AuthService();
  return _instance;
}
