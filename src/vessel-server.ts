import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AnalysisAPIClient } from './api-client.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { CircuitState } from './circuit-breaker.js';
import { TOOL_REGISTRY, getAllTools } from './tools/index.js';
import type { AuthService } from './auth-service.js';
import { ZodError } from 'zod';

export interface VesselServerConfig {
  port: number;
  apiClient: AnalysisAPIClient;
  circuitBreaker: CircuitBreaker;
  sessionId: string;
  /** Raw API key used for incoming request auth (ide.metabob.com key). */
  apiKey?: string;
  /** Auth service used for identity-vessel key validation. */
  authService: AuthService;
}

const VERSION = '0.1.0';

export class VesselServer {
  private nodeServer: Server | null = null;
  private config: VesselServerConfig;

  constructor(config: VesselServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const app = this.buildApp();
    const { port } = this.config;

    this.nodeServer = await this.startNodeServer(app, port);
    console.error(`[${new Date().toISOString()}] [INFO] Vessel server listening on port ${port}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.nodeServer) {
        this.nodeServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private startNodeServer(app: Hono, port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = `http://localhost:${port}${req.url ?? '/'}`;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }

        let body: Buffer | undefined;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await new Promise<Buffer>((res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => res(Buffer.concat(chunks)));
          });
        }

        const request = new Request(url, {
          method: req.method,
          headers,
          body: body?.length ? body : undefined,
        });

        const response = await app.fetch(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(await response.text());
      });

      server.listen(port, () => resolve(server));
      server.once('error', reject);
    });
  }

  private buildApp(): Hono {
    const app = new Hono();
    const { apiClient, circuitBreaker, sessionId, apiKey, authService } = this.config;

    app.use('*', cors());

    // ── Liveness ──────────────────────────────────────────────────────────────

    app.get('/health', (c) => {
      const state = circuitBreaker.getState();
      if (state === CircuitState.OPEN) {
        return c.json({ status: 'unhealthy', reason: 'circuit breaker open', circuitState: state }, 503);
      }
      return c.json({ status: 'healthy', circuitState: state, timestamp: new Date().toISOString() });
    });

    app.get('/ready', (c) => {
      const state = circuitBreaker.getState();
      if (state === CircuitState.OPEN) {
        return c.json({ ready: false, reason: 'circuit breaker open' }, 503);
      }
      return c.json({ ready: true, circuitState: state });
    });

    // ── Capabilities ──────────────────────────────────────────────────────────

    app.get('/v2/capabilities', (c) => {
      return c.json({
        id: 'metabob-mcp',
        version: VERSION,
        shapes: [
          'mcp:tool_call',
          'code:cochange_prediction',
          'code:impact_analysis',
          'code:git_change_assignment',
          'code:analysis_context',
        ],
        protocols: ['mcp:stdio', 'http:resolver'],
        tools: getAllTools().map(t => ({ name: t.name, description: t.description })),
        resolver: { endpoint: '/v2/impulses/resolve', authScheme: 'ApiKey', timeoutMs: 30000 },
      });
    });

    // ── Impulse resolver ──────────────────────────────────────────────────────

    app.post('/v2/impulses/resolve', async (c) => {
      // Auth check — accept either the ide.metabob.com key (METABOB_API_KEY)
      // or the identity.metabob.com key (IDENTITY_API_KEY) during the
      // interim period where both backends are in use.
      const identityKey = authService.getIdentityApiKey();
      if (apiKey || identityKey) {
        const auth = c.req.header('authorization') ?? '';
        const provided = auth.startsWith('ApiKey ') ? auth.slice(7)
          : auth.startsWith('Bearer ') ? auth.slice(7)
          : auth;
        const validKeys = new Set([apiKey, identityKey].filter(Boolean) as string[]);
        if (!validKeys.has(provided)) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }

      let body: { impulses?: unknown[] };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      if (!Array.isArray(body.impulses)) {
        return c.json({ error: 'body.impulses must be an array' }, 400);
      }

      const resolved = await Promise.all(
        body.impulses.map(async (impulse: any) => {
          const id: string = impulse.id ?? crypto.randomUUID();
          const pointer = impulse.pointer ?? {};
          const startTime = Date.now();

          try {
            const { toolName, toolInput } = resolvePointerToTool(pointer);
            const tool = TOOL_REGISTRY[toolName];

            if (!tool) {
              return {
                id,
                loaded: false,
                error: `Unknown tool: ${toolName}`,
                metadata: { duration_ms: Date.now() - startTime },
              };
            }

            const validatedInput = tool.validateInput(toolInput);
            const content = await tool.handler(validatedInput, apiClient, sessionId);

            return {
              id,
              loaded: true,
              content,
              metadata: {
                tool: toolName,
                shape: pointer.type,
                duration_ms: Date.now() - startTime,
              },
            };
          } catch (err) {
            const message = err instanceof ZodError
              ? err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
              : err instanceof Error ? err.message : String(err);

            return {
              id,
              loaded: false,
              error: message,
              metadata: { duration_ms: Date.now() - startTime },
            };
          }
        }),
      );

      return c.json({ resolved });
    });

    return app;
  }
}

/**
 * Map an impulse pointer to a tool name and input.
 *
 * Supports three shapes:
 *   mcp:tool_call           — pointer.tool + pointer.input
 *   code:cochange_prediction — pointer.changed_files, pointer.limit, pointer.confidence_threshold
 *   code:impact_analysis    — pointer.changed_files, pointer.direction, pointer.max_depth, pointer.include_tests
 */
function resolvePointerToTool(pointer: Record<string, unknown>): {
  toolName: string;
  toolInput: Record<string, unknown>;
} {
  const shape = pointer.type as string | undefined;

  if (shape === 'mcp:tool_call') {
    const toolName = pointer.tool as string;
    if (!toolName) throw new Error('pointer.tool is required for mcp:tool_call');
    const toolInput = (pointer.input as Record<string, unknown>) ?? {};
    return { toolName, toolInput };
  }

  if (shape === 'code:cochange_prediction') {
    return {
      toolName: 'predict_cochanges',
      toolInput: {
        changed_files: pointer.changed_files,
        limit: pointer.limit,
        confidence_threshold: pointer.confidence_threshold,
      },
    };
  }

  if (shape === 'code:impact_analysis') {
    return {
      toolName: 'analyze_impact',
      toolInput: {
        changed_files: pointer.changed_files,
        diff: pointer.diff,
        direction: pointer.direction,
        max_depth: pointer.max_depth,
        include_tests: pointer.include_tests,
      },
    };
  }

  if (shape === 'code:git_change_assignment') {
    return {
      toolName: 'assign_git_changes',
      toolInput: {
        changed_files: pointer.changed_files,
        diff: pointer.diff,
        include_cochange_predictions: pointer.include_cochange_predictions,
        prediction_limit: pointer.prediction_limit,
      },
    };
  }

  if (shape === 'code:analysis_context') {
    return {
      toolName: 'get_analysis_context',
      toolInput: {
        recently_changed_files: pointer.recently_changed_files,
        problem_limit: pointer.problem_limit,
        scope: pointer.scope,
      },
    };
  }

  throw new Error(
    `Unknown impulse shape: ${shape ?? '(none)'}. Supported: mcp:tool_call, code:cochange_prediction, code:impact_analysis, code:git_change_assignment, code:analysis_context`,
  );
}
