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
  /** discovery-vessel / activity-api endpoint (e.g. https://ide.metabob.com) */
  activityEndpoint: string;
  vesselId: string;
  vesselName: string;
  /** This vessel's own reachable HTTP base URL. */
  endpoint: string;
  shapes: string[];
  metadata?: Record<string, unknown>;
  ttl?: number;
  heartbeatIntervalMs?: number;
  authService: AuthService;
}

export class VesselHeartbeat {
  private config: Required<Omit<VesselHeartbeatConfig, 'heartbeatIntervalMs' | 'metadata'>> & {
    heartbeatIntervalMs: number;
    metadata: Record<string, unknown>;
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
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? (ttl * 1000) / 2,
    };
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
    const { activityEndpoint, vesselId, vesselName, endpoint, shapes, metadata, ttl, authService } =
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
      endpoint,
      shapes,
      metadata,
      ttl,
      // Wave 1A: resolve-contract self-description
      resolve_endpoint: '/v2/impulses/resolve',
      resolve_request_format: 'pointer',
      auth_scheme: 'ApiKey',
      resolve_timeout_ms: 30_000,
      // Wave A3: auth-token-source contract
      auth_token_source: 'header',
      auth_delegation_mode: 'direct',
    };

    try {
      const url = `${activityEndpoint}/v2/vessels/register`;
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
