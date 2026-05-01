/**
 * Dual-backend authentication service.
 *
 * Two auth paths run in parallel during the transition period:
 *
 *   ide.metabob.com path  — existing analysis API; handled by AnalysisAPIClient
 *                           via POST /v2/auth/apikey → JWT. That flow is
 *                           unchanged; this service does NOT touch it.
 *
 *   identity.metabob.com path — new vessel system; this service calls
 *                           POST /v1/auth/resolve with the impulse form to
 *                           resolve orgId/userId and capture an inline JWT
 *                           for use against discovery + activity vessels.
 *
 * Env vars:
 *   METABOB_API_KEY   — key for ide.metabob.com (analysis API)
 *   IDENTITY_API_KEY  — key for identity.metabob.com (vessel system);
 *                       falls back to METABOB_API_KEY when not set
 *   IDENTITY_ENDPOINT — defaults to https://identity.metabob.com
 */

const DEFAULT_IDENTITY_ENDPOINT = 'https://identity.metabob.com';
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
    if (!apiKey) return;

    const url = `${endpoint ?? process.env.IDENTITY_ENDPOINT ?? DEFAULT_IDENTITY_ENDPOINT}/v1/auth/resolve`;
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

  /** API key to use against identity.metabob.com / vessel system. */
  getIdentityApiKey(): string | undefined {
    const key = process.env.IDENTITY_API_KEY ?? process.env.METABOB_API_KEY;
    if (key) return key;
    if (this.state.status !== 'unauthenticated') return this.state.apiKey;
    return undefined;
  }

  /** Bearer JWT for vessel-to-vessel calls (e.g. discovery registration). */
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
