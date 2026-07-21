/**
 * Vessel registration + heartbeat against discovery-vessel.
 *
 * Sends the full Wave 1A/A3 resolve-contract fields so discovery consumers
 * know how to call this vessel's impulse resolver without extra round-trips.
 *
 * Adapted from minibob's VesselHeartbeat with the extended registration
 * payload required by discovery-vessel ≥ 2026-04-23.
 */

import type { AuthService } from './auth-service.js';
import { fetchWithBearerFallback } from './auth-header.js';

const MAX_FAILURES = 3;
const DEFAULT_TTL_S = 300;

export interface VesselHeartbeatConfig {
  /**
   * discovery-vessel base URL. Registration posts to `${discoveryEndpoint}/register`
   * — the compliant path (the activity-api `/v2/vessels/register` proxy is
   * deprecated). Derived point-and-go from the join endpoint; never hardcoded.
   */
  discoveryEndpoint: string;
  vesselId: string;
  vesselName: string;
  /** Vessel version, advertised in the registration row. */
  version: string;
  /** This vessel's own reachable HTTP base URL. */
  endpoint: string;
  shapes: string[];
  metadata?: Record<string, unknown>;
  ttl?: number;
  /** Advertised resolve timeout (ms); goal-host uses it as the solicitation deadline. Default 30s. */
  resolveTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  authService: AuthService;
  /**
   * Optional supplier of extra registration fields recomputed each cycle —
   * used to advertise the libp2p transport row (protocol/peerId/multiaddr)
   * once a circuit reservation exists. Read at register() time (use-time), so
   * a late-arriving circuit is picked up on the next heartbeat.
   */
  extraFields?: () => Record<string, unknown>;
}

export class VesselHeartbeat {
  private config: Required<Omit<VesselHeartbeatConfig, 'heartbeatIntervalMs' | 'metadata' | 'extraFields' | 'resolveTimeoutMs'>> & {
    heartbeatIntervalMs: number;
    metadata: Record<string, unknown>;
    resolveTimeoutMs: number;
    extraFields?: () => Record<string, unknown>;
  };
  private intervalHandle?: Timer;
  private running = false;
  private failures = 0;
  lastRegistered?: Date;

  constructor(config: VesselHeartbeatConfig) {
    const ttl = config.ttl ?? DEFAULT_TTL_S;
    this.config = {
      ...config,
      ttl,
      metadata: config.metadata ?? {},
      resolveTimeoutMs: config.resolveTimeoutMs ?? 30_000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? (ttl * 1000) / 2,
    };
  }

  /**
   * Replace the advertised shape-set and re-register immediately so the change
   * is visible before the next heartbeat tick. No-op if the set is unchanged.
   * This is the actuator for shape-driven mode (Law 1): the presence-advertiser
   * recomputes which shapes to serve from a use-time condition and calls this.
   */
  async setShapes(shapes: string[]): Promise<void> {
    const next = [...shapes];
    const changed =
      next.length !== this.config.shapes.length ||
      next.some((s, i) => s !== this.config.shapes[i]);
    if (!changed) return;
    this.config.shapes = next;
    if (this.running) await this.register();
  }

  async start(): Promise<void> {
    if (this.running) return;

    await this.register();

    this.intervalHandle = setInterval(() => {
      this.register().catch(err => {
        console.error(`[vessel-heartbeat] interval error: ${err instanceof Error ? err.message : err}`);
      });
    }, this.config.heartbeatIntervalMs);

    this.running = true;
    console.error(
      `[vessel-heartbeat] started for ${this.config.vesselId} ` +
        `(ttl=${this.config.ttl}s interval=${this.config.heartbeatIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (!this.running) return;
    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
    this.running = false;
    console.error(`[vessel-heartbeat] stopped for ${this.config.vesselId}`);
  }

  async register(): Promise<boolean> {
    const { discoveryEndpoint, vesselId, vesselName, version, endpoint, shapes, metadata, ttl, resolveTimeoutMs, authService, extraFields } =
      this.config;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Prefer Bearer JWT from identity-vessel; fall back to raw ApiKey.
    // If the bearer token is stale, attempt a non-blocking refresh.
    if (authService.bearerTokenIsStale()) {
      authService.refreshTenant().catch(() => {});
    }
    const bearer = authService.getBearerToken();
    const identityApiKey = authService.getIdentityApiKey();
    // JWT bearer takes precedence; otherwise we let fetchWithBearerFallback
    // pick the scheme for the raw API key (Bearer-first, ApiKey fallback).
    if (bearer) {
      headers['Authorization'] = `Bearer ${bearer}`;
    }

    const body = {
      vesselId,
      vesselName,
      version,
      endpoint,
      shapes,
      metadata,
      ttl,
      // Wave 1A: resolve-contract self-description
      resolve_endpoint: '/v2/impulses/resolve',
      resolve_request_format: 'pointer',
      auth_scheme: 'ApiKey',
      resolve_timeout_ms: resolveTimeoutMs,
      // Wave A3: auth-token-source contract
      auth_token_source: 'header',
      auth_delegation_mode: 'direct',
      // Transport row (protocol / libp2p_peer_id / libp2p_multiaddr) when a
      // circuit reservation exists — recomputed each cycle at use-time.
      ...(extraFields ? extraFields() : {}),
    };

    try {
      const url = `${discoveryEndpoint}/register`;
      const reqInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      };
      const res = bearer || !identityApiKey
        ? await fetch(url, reqInit)
        : await fetchWithBearerFallback({
            url,
            apiKey: identityApiKey,
            init: reqInit,
          });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[vessel-heartbeat] registration HTTP ${res.status}: ${text.slice(0, 120)}`);
        this.onFailure();
        return false;
      }

      this.lastRegistered = new Date();
      this.failures = 0;
      console.error(`[vessel-heartbeat] registered ${vesselId} shapes=[${shapes.join(', ')}]`);
      return true;
    } catch (err) {
      console.error(`[vessel-heartbeat] registration error: ${err instanceof Error ? err.message : err}`);
      this.onFailure();
      return false;
    }
  }

  private onFailure(): void {
    this.failures++;
    if (this.failures >= MAX_FAILURES) {
      console.error(`[vessel-heartbeat] ${MAX_FAILURES} consecutive failures — stopping`);
      this.stop();
    }
  }

  status() {
    return {
      running: this.running,
      lastRegistered: this.lastRegistered,
      consecutiveFailures: this.failures,
      vesselId: this.config.vesselId,
    };
  }
}
