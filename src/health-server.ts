/**
 * Health check HTTP server for Kubernetes probes
 * Runs on a separate port from MCP stdio transport
 */

import type { AnalysisAPIClient } from './api-client.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { CircuitState } from './circuit-breaker.js';

export interface HealthServerConfig {
  port: number;
  apiClient: AnalysisAPIClient;
  circuitBreaker: CircuitBreaker;
}

export class HealthServer {
  private server: any;
  private config: HealthServerConfig;

  constructor(config: HealthServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const { port, apiClient, circuitBreaker } = this.config;

    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);

        // Health check endpoint
        if (url.pathname === '/health') {
          try {
            // Check circuit breaker state
            const circuitState = circuitBreaker.getState();
            if (circuitState === CircuitState.OPEN) {
              return new Response(
                JSON.stringify({
                  status: 'unhealthy',
                  reason: 'Circuit breaker is open',
                  circuitState,
                }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' },
                }
              );
            }

            // Optionally check API connectivity
            // (commented out to avoid making health checks depend on external service)
            // await apiClient.health();

            return new Response(
              JSON.stringify({
                status: 'healthy',
                circuitState,
                timestamp: new Date().toISOString(),
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          } catch (error) {
            return new Response(
              JSON.stringify({
                status: 'unhealthy',
                reason: 'API health check failed',
                error: error instanceof Error ? error.message : String(error),
              }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }
        }

        // Readiness check endpoint
        if (url.pathname === '/ready') {
          const circuitState = circuitBreaker.getState();

          if (circuitState === CircuitState.OPEN) {
            return new Response(
              JSON.stringify({
                ready: false,
                reason: 'Circuit breaker is open',
              }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          return new Response(
            JSON.stringify({
              ready: true,
              circuitState,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Not found
        return new Response('Not Found', { status: 404 });
      },
    });

    console.error(
      `[${new Date().toISOString()}] [INFO] Health server listening on port ${port}`
    );
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      console.error(
        `[${new Date().toISOString()}] [INFO] Health server stopped`
      );
    }
  }
}
