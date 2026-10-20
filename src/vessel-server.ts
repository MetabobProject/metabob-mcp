import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AnalysisAPIClient } from './api-client.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { CircuitState } from './circuit-breaker.js';
import { TOOL_REGISTRY, getAllTools, substrateToolRefusal } from './tools/index.js';
import type { AuthService } from './auth-service.js';
import type { LocalStore, AgentTaskRecord } from './local-store.js';
import { VESSEL_VERSION, VESSEL_BASE_NAME, SERVED_SHAPES } from './vessel-identity.js';
import { getResolverVesselId, getResolverOperatorId } from './resolver-identity.js';
import { unattachedMessage } from './config.js';
import { getAttachment } from './attachment.js';
import { proxySummary } from './net.js';
import { ZodError } from 'zod';
import { guardToolInput } from './outgoing-guard.js';

/**
 * Shapes the substrate DISPATCHES TO the agent (solicited decisions) rather than
 * shapes the vessel resolves synchronously. An impulse of one of these is
 * durably enqueued for the agent to pull, and ACKed immediately (goal-host's
 * accept-then-callback contract). Kept out of resolvePointerToTool so the
 * synchronous "unknown shape → throw" invariant is untouched. SPEC §impulse-shapes.
 */
export const QUEUED_SHAPES = new Set(['human_input']);

export function isAgentTaskShape(shape?: string): boolean {
  return !!shape && QUEUED_SHAPES.has(shape);
}

/** Parse METABOB_TOOLS. `null` = no allowlist configured (everything permitted). */
export function parseToolAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const names = trimmed.split(',').map(n => n.trim()).filter(n => n.length > 0);
  return names.length > 0 ? new Set(names) : null;
}

let allowlistMemo: { value: ReadonlySet<string> | null } | null = null;

/**
 * The METABOB_TOOLS allowlist applies to EVERY plane this process serves, not
 * just stdio MCP: the loopback HTTP resolver dispatches through
 * resolveImpulseContent, so an allowlist enforced only in the MCP handlers is a
 * control on one of two doors. Memoised on first call — the env is frozen at
 * process start in production, but a memo (unlike a module const) is resettable,
 * and unassertable enforcement is exactly how this drifted for two releases.
 */
export function isToolPermitted(name: string): boolean {
  if (!allowlistMemo) allowlistMemo = { value: parseToolAllowlist(process.env['METABOB_TOOLS']) };
  return allowlistMemo.value === null || allowlistMemo.value.has(name);
}

/** True when an allowlist is configured at all — for reporting, not enforcement. */
export function toolAllowlistActive(): boolean {
  if (!allowlistMemo) allowlistMemo = { value: parseToolAllowlist(process.env['METABOB_TOOLS']) };
  return allowlistMemo.value !== null;
}

/** The refusal every plane gives, so a caller cannot tell them apart by wording. */
export function toolNotEnabledMessage(name: string): string {
  return `Tool "${name}" is not enabled for this vessel (METABOB_TOOLS allowlist).`;
}

export function __resetToolAllowlistForTests(): void {
  allowlistMemo = null;
}

/**
 * Accept a dispatched agent task: durably enqueue it (keyed by the stable
 * vesselId so a later session resumes it) and return the synchronous ACK.
 * goal-host only checks the POST is 2xx and reads the answer later via
 * solicitationResponse_write, so the ACK content is informational. Throws on a
 * non-decision-ready payload or when coordination is unavailable, which surfaces
 * as a loaded:false result (still HTTP 200) — goal-host then times out and
 * proceeds to honest failure rather than parking on a task we never queued.
 */
function acceptAgentTask(
  pointer: Record<string, unknown>,
  shape: string,
  sessionId: string,
  localStore?: LocalStore | null,
): string {
  const vesselId = getResolverVesselId();
  if (!localStore || !vesselId) {
    throw new Error('insufficient_context: agent-resolver coordination unavailable');
  }
  const question = typeof pointer['question_markdown'] === 'string' ? pointer['question_markdown'].trim() : '';
  if (!question) {
    throw new Error('insufficient_context: question_markdown is required and must be decision-ready');
  }
  const taskId = (typeof pointer['solicitation_id'] === 'string' && pointer['solicitation_id'])
    || (typeof pointer['id'] === 'string' && pointer['id'])
    || crypto.randomUUID();
  const timeoutMs = typeof pointer['timeout_ms'] === 'number' && pointer['timeout_ms'] > 0
    ? pointer['timeout_ms'] : 300_000;
  const rec: AgentTaskRecord = {
    task_id: taskId,
    vessel_id: vesselId,
    operator_id: getResolverOperatorId(),
    session_id: sessionId,
    shape,
    dispatch_id: typeof pointer['dispatch_id'] === 'string' ? pointer['dispatch_id'] : null,
    question_markdown: question,
    respond_via_json: JSON.stringify(pointer['respond_via'] ?? { shape: 'solicitationResponse_write' }),
    deadline_ms: Date.now() + timeoutMs,
    status: 'pending',
    enqueued_at: Date.now(),
    claimed_at: null,
  };
  localStore.enqueueAgentTask(rec);
  return JSON.stringify({
    accepted: true,
    solicitation_id: taskId,
    will_respond_via: 'solicitationResponse_write',
  });
}

export interface VesselServerConfig {
  port: number;
  apiClient: AnalysisAPIClient;
  circuitBreaker: CircuitBreaker;
  sessionId: string;
  /** Raw API key used for incoming request auth (METABOB_API_KEY). */
  apiKey?: string;
  /** Auth service used for identity-vessel key validation. */
  authService: AuthService;
  /**
   * Process-wide local SQLite cache. Threaded to tool handlers as the 4th arg
   * so HTTP-resolved calls (get_problems / get_analysis_context / record_finding)
   * hit the same cache the MCP path uses, instead of a degraded no-cache branch.
   */
  localStore?: LocalStore | null;
}

const VERSION = VESSEL_VERSION;

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
    console.error(`[${new Date().toISOString()}] [INFO] Vessel server listening on port ${this.boundPort ?? port} (127.0.0.1)`);
  }

  /** The port actually bound (resolves an ephemeral port 0), or null when not listening. */
  get boundPort(): number | null {
    const addr = this.nodeServer?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
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

      // CONFORMANCE §c2-endpoint
      // @anchor loopback-bind
      // Loopback only: the resolver serves local callers, and nothing advertises
      // it — a client-only process has no reader outside this network namespace.
      server.listen(port, '127.0.0.1', () => resolve(server));
      server.once('error', reject);
    });
  }

  /** Public so the resolver can be driven via `app.fetch(new Request(...))` without binding a socket. */
  buildApp(): Hono {
    const app = new Hono();
    const { apiClient, circuitBreaker, sessionId, apiKey, authService, localStore } = this.config;

    app.use('*', cors());

    // ── Liveness ──────────────────────────────────────────────────────────────

    // CONFORMANCE §c9-fail-visibly
    // @anchor health-attachment
    // The attachment state is reported, never dropped: the anchor and how it
    // was obtained, the /bootstrap result, the identity chosen (advertised and
    // tried), the org check, the one named cause, and that the process
    // advertises nothing. `attached` is true only once the key is proven.
    const attachment = () => {
      const missing = unattachedMessage();
      const current = getAttachment();
      if (!current) {
        // Without an attachment there is still a network to report: the proxy
        // configuration, credentials redacted (src/net.ts@redact-credentials).
        const network = { proxy: proxySummary() };
        return missing
          ? { attached: false, reason: missing, advertised: 'none' as const, network }
          : { attached: false, reason: 'the attachment has not started', advertised: 'none (client-only)' as const, network };
      }
      const state = current.state();
      const attached = state.auth.status === 'authenticated' && state.cause === null;
      const reason = attached ? undefined : state.message ?? (state.auth.status === 'pending' ? 'attaching' : missing ?? undefined);
      return { attached, ...(reason ? { reason } : {}), ...state };
    };

    app.get('/health', (c) => {
      const state = circuitBreaker.getState();
      if (state === CircuitState.OPEN) {
        return c.json({ status: 'unhealthy', reason: 'circuit breaker open', circuitState: state, attachment: attachment() }, 503);
      }
      return c.json({ status: 'healthy', circuitState: state, attachment: attachment(), timestamp: new Date().toISOString() });
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
        id: VESSEL_BASE_NAME,
        version: VERSION,
        shapes: [...SERVED_SHAPES],
        protocols: ['mcp:stdio', 'http:resolver'],
        tools: getAllTools().map(t => ({ name: t.name, description: t.description })),
        resolver: { endpoint: '/v2/impulses/resolve', authScheme: 'ApiKey', timeoutMs: 30000 },
      });
    });

    // ── Impulse resolver ──────────────────────────────────────────────────────

    app.post('/v2/impulses/resolve', async (c) => {
      // Auth check — accept the substrate key (METABOB_API_KEY) or a separate
      // identity key (IDENTITY_API_KEY) when one is configured.
      //
      // FAIL CLOSED when neither is configured (anonymous mode): this surface
      // dispatches init_workspace, search_codebase, record_finding and
      // resolve_impulse, and /v2/capabilities advertises authScheme:ApiKey, so
      // an anonymous caller has no credential it could ever present. Loopback
      // binding narrows who can reach it; the key decides who may use it.
      // Resolved per-request, never at build time: the identity key arrives
      // asynchronously after start. CONFORMANCE §c3-identity
      const identityKey = authService.getIdentityApiKey();
      const validKeys = new Set([apiKey, identityKey].filter(Boolean) as string[]);
      if (validKeys.size === 0) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const auth = c.req.header('authorization') ?? '';
      const provided = auth.startsWith('ApiKey ') ? auth.slice(7)
        : auth.startsWith('Bearer ') ? auth.slice(7)
        : auth;
      if (!validKeys.has(provided)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      let body: { impulses?: unknown[]; pointer?: unknown; type?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      // Accept either the batch envelope {impulses:[{pointer}]} or the single
      // {type, pointer} envelope goal-host uses for solicitations (human_input).
      const impulses: unknown[] = Array.isArray(body.impulses)
        ? body.impulses
        : body.pointer
          ? [{ pointer: body.pointer }]
          : [];
      if (impulses.length === 0) {
        return c.json({ error: 'body.impulses must be an array, or provide a single pointer' }, 400);
      }

      const resolved = await Promise.all(
        impulses.map(async (impulse: any) => {
          const id: string = impulse.id ?? crypto.randomUUID();
          const pointer = impulse.pointer ?? {};
          const startTime = Date.now();

          try {
            const { toolName, content } = await resolveImpulseContent(pointer, apiClient, sessionId, localStore);
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
 * Resolve a single impulse pointer to its tool output, for the HTTP resolver
 * (`POST /v2/impulses/resolve`): same shape → same tool → same content. Throws
 * on unknown tool or validation failure; the caller wraps the error.
 */
export async function resolveImpulseContent(
  pointer: Record<string, unknown>,
  apiClient: AnalysisAPIClient,
  sessionId: string,
  localStore?: LocalStore | null,
): Promise<{ toolName: string; content: unknown }> {
  // Agent-task shapes (e.g. human_input) are DISPATCHED to the agent: enqueue
  // durably + ACK, instead of resolving synchronously.
  const shape = typeof pointer['type'] === 'string' ? (pointer['type'] as string) : undefined;
  if (isAgentTaskShape(shape)) {
    return { toolName: shape!, content: acceptAgentTask(pointer, shape!, sessionId, localStore) };
  }

  const { toolName, toolInput } = resolvePointerToTool(pointer);
  // Gate AFTER shape→tool mapping so every shape is covered, not just
  // mcp:tool_call.
  if (!isToolPermitted(toolName)) {
    throw new Error(toolNotEnabledMessage(toolName));
  }
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const guarded = guardToolInput(toolName, tool.validateInput(toolInput) as Record<string, unknown>);
  if (!guarded.ok) {
    throw new Error(guarded.refusal);
  }
  const validatedInput = guarded.input;
  // The attachment gate, as on stdio: a substrate tool refuses with the named cause.
  const refusal = await substrateToolRefusal(toolName);
  if (refusal) {
    throw new Error(refusal);
  }
  const content = await tool.handler(validatedInput, apiClient, sessionId, localStore);
  return { toolName, content };
}

/**
 * Map an impulse pointer to a tool name and input. The shape → tool table and
 * the pointer fields each shape forwards are SPEC §impulse-shapes; queued
 * shapes (QUEUED_SHAPES) never reach this function.
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
