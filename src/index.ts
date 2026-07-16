#!/usr/bin/env node
/**
 * MCP Server for Metabob Analysis API
 * Exposes code analysis tools to AI agents via MCP protocol
 */

// Install OS trust store before any HTTPS fires. Idempotent — if cli.ts
// already ran this, subsequent calls are no-ops. Covers the case where
// users run `bun src/index.ts` or import this module directly.
import { installSystemTrustStoreSync } from './tls-trust.js';
installSystemTrustStoreSync({ disabled: process.env.METABOB_NO_SYSTEM_CA === '1' });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { AnalysisAPIClient } from './api-client.js';
import { SessionManager } from './session-manager.js';
import { TOOL_REGISTRY, getAllTools } from './tools/index.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker, CircuitState } from './circuit-breaker.js';
import { VesselServer } from './vessel-server.js';
import { AuthService } from './auth-service.js';
import { Telemetry, extractOutcomePayload } from './telemetry.js';
import { pickMonitoredHosts, probeHostFingerprint } from './cert-fingerprint.js';
import { getLastTrustSummary } from './tls-trust.js';
import { LocalStore } from './local-store.js';
import { Scheduler } from './scheduler.js';
import { startWatcher } from './watcher.js';
import { startGitWatcher } from './git-watcher.js';
import { resolveWorkspaceId } from './workspace.js';
import { ZodError } from 'zod';

const MCP_VERSION = '0.2.11';

// ── Configuration ────────────────────────────────────────────────────────────
const ANALYSIS_API_URL = process.env.ANALYSIS_API_URL || 'https://ide.metabob.com';
const ACTIVITY_API_URL = process.env.ACTIVITY_API_URL || process.env.ANALYSIS_API_URL || 'https://activity.metabob.com';
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_ENDPOINT;

/**
 * When METABOB_STATELESS=true we use the original per-call HTTP behavior
 * unchanged (legacy REST surface with POST /session exchange). Otherwise
 * "sidecar mode" is active: tool reads are served from the local SQLite cache,
 * telemetry is batched to the analysis-api, and the analysis endpoint is
 * treated as an impulse-resolving vessel. No hostname is special-cased —
 * all deployments (local substrate, org-split corp) speak the vessel protocol.
 */
const SIDECAR_MODE = process.env.METABOB_STATELESS !== 'true';

/** Stable session identifier — callers may inject SESSION_ID; otherwise a fresh UUID. */
const SESSION_ID = process.env.SESSION_ID || crypto.randomUUID();
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_REQUESTS_PER_MINUTE = Number(process.env.MAX_REQUESTS_PER_MINUTE) || 60;
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 8080;
const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT_MS) || 120000;
const METABOB_API_KEY = process.env.METABOB_API_KEY;
/** Pre-obtained session token (skips the key-exchange step). */
const SESSION_TOKEN = process.env.SESSION_TOKEN;
const USE_CONNECTION_SLOTS = process.env.USE_CONNECTION_SLOTS === 'true';

// Identity (tenant resolution only — discovery registration removed)
const IDENTITY_ENDPOINT = process.env.IDENTITY_ENDPOINT || (DISCOVERY_ENDPOINT ? undefined : 'https://identity.metabob.com');

/**
 * Vessel mode: ANALYSIS_API_URL points at a discovery-style impulse resolver
 * (substrate analysis-vessel) instead of the legacy ide.metabob.com REST surface.
 * Same gate as SIDECAR_MODE today; kept as a separate name for clarity.
 */
const VESSEL_MODE = SIDECAR_MODE;

// Initialize clients
const apiClient = new AnalysisAPIClient({
  baseURL: ANALYSIS_API_URL,
  discoveryEndpoint: DISCOVERY_ENDPOINT,
  activityApiUrl: ACTIVITY_API_URL,
  timeout: 30000,
  submitTimeoutMs: SUBMIT_TIMEOUT_MS,
  retryAttempts: 3,
  retryDelayMs: 100,
  apiKey: METABOB_API_KEY,
  sessionToken: SESSION_TOKEN,
  useConnectionSlots: USE_CONNECTION_SLOTS && !VESSEL_MODE,
  vesselMode: VESSEL_MODE,
  onConnectionStateChange: (state) => {
    log('info', `Connection state changed: ${state}`);
  },
});

const sessionManager = new SessionManager({
  timeoutMs: 3600000, // 1 hour
  cleanupIntervalMs: 300000, // 5 minutes
});

const rateLimiter = new RateLimiter({
  requestsPerMinute: MAX_REQUESTS_PER_MINUTE,
  windowMs: 60000,
});

const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 60000,
});

// ── Auth service (identity.metabob.com path) ─────────────────────────────────
const authService = new AuthService();
const identityApiKey = process.env.IDENTITY_API_KEY ?? METABOB_API_KEY;
if (identityApiKey) {
  authService.setApiKey(identityApiKey);
}

// ── Usage telemetry ──────────────────────────────────────────────────────────
// In sidecar mode: batches events to ${ANALYSIS_API_URL}/v2/events/mcp.
// In legacy mode (ide.metabob.com): fire-and-forget to user-vessel /v2/mcp/usage.
// Disabled by METABOB_TELEMETRY=off or when no API key is configured.
const telemetry = new Telemetry({
  endpoint: process.env.USER_VESSEL_URL,
  analysisApiUrl: ANALYSIS_API_URL,
  apiKey: identityApiKey,
  mcpVersion: MCP_VERSION,
  sessionId: SESSION_ID,
});

// ── Local SQLite store (sidecar mode only) ────────────────────────────────────
// In anonymous mode (no API key), we still init the store and watchers but
// skip telemetry flushes and scheduler sends.
const ANONYMOUS_MODE = SIDECAR_MODE && !METABOB_API_KEY;

const localStore = SIDECAR_MODE ? new LocalStore() : null;
if (localStore) {
  try {
    localStore.init();
  } catch (err) {
    // Non-fatal: sidecar features degrade gracefully if SQLite is unavailable.
    console.error('[warn] LocalStore init failed:', err);
  }
}

if (ANONYMOUS_MODE) {
  console.error('[sidecar] anonymous mode — caching disabled, watchers active');
}

// ── Sidecar workers (same-process, lightweight timers) ────────────────────────
let scheduler: Scheduler | null = null;
let stopWatcher: (() => void) | null = null;
let stopGitWatcher: (() => void) | null = null;

const vesselServer = new VesselServer({
  port: HEALTH_PORT,
  apiClient,
  circuitBreaker,
  sessionId: SESSION_ID,
  apiKey: METABOB_API_KEY,
  authService,
});

// Create MCP server
const server = new Server(
  {
    name: 'metabob-mcp',
    version: '0.2.15',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Log function
function log(level: string, message: string, data?: any) {
  if (LOG_LEVEL === 'debug' || (LOG_LEVEL === 'info' && level !== 'debug')) {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
  }
}

/**
 * List all available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('debug', 'Listing tools');

  const tools = getAllTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  log('info', `Registered ${tools.length} tools`);

  return { tools };
});

/**
 * Handle tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log('info', `Tool call: ${name}`, { args });

  const startTime = Date.now();
  let success = false;
  let validatedInput: Record<string, unknown> | undefined;

  try {
    // Check rate limit
    const rateLimitAllowed = await rateLimiter.checkLimit(SESSION_ID);
    if (!rateLimitAllowed) {
      const resetTime = rateLimiter.getResetTime(SESSION_ID);
      throw new McpError(
        ErrorCode.InternalError,
        `Rate limit exceeded: ${MAX_REQUESTS_PER_MINUTE} requests per minute. Try again in ${Math.ceil(resetTime / 1000)}s.`,
        {
          code: 'RATE_LIMIT_EXCEEDED',
          resetTimeMs: resetTime,
          limit: MAX_REQUESTS_PER_MINUTE,
        }
      );
    }

    // Check circuit breaker
    if (!circuitBreaker.isAllowed()) {
      const resetTime = circuitBreaker.getResetTime();
      throw new McpError(
        ErrorCode.InternalError,
        `Analysis API is temporarily unavailable due to repeated failures. Circuit breaker is open. Try again in ${Math.ceil(resetTime / 1000)}s.`,
        {
          code: 'SERVICE_UNAVAILABLE',
          circuitState: circuitBreaker.getState(),
          resetTimeMs: resetTime,
        }
      );
    }

    // Get tool from registry
    const tool = TOOL_REGISTRY[name];

    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}. Available tools: ${Object.keys(TOOL_REGISTRY).join(', ')}`
      );
    }

    // Validate input
    try {
      validatedInput = tool.validateInput(args || {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters for tool ${name}: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
        );
      }
      throw error;
    }

    // Execute tool — pass localStore as fourth arg for cache-aware handlers
    const result = await (tool.handler as (
      input: any,
      apiClient: any,
      sessionId: string,
      localStore?: LocalStore | null,
    ) => Promise<string>)(validatedInput, apiClient, SESSION_ID, localStore);

    success = true;
    circuitBreaker.recordSuccess();

    // Track usage
    const duration = Date.now() - startTime;
    await sessionManager.trackUsage(SESSION_ID, name, duration, success);

    // Extract optional file path from input (present on get_problems, search_codebase, etc.)
    const inputRecord = (validatedInput as Record<string, unknown> | null) ?? {};
    const filePath =
      typeof inputRecord['file_path'] === 'string' ? inputRecord['file_path'] : undefined;

    // Fire-and-forget telemetry.
    telemetry.record({
      tool_name: name,
      success: true,
      duration_ms: duration,
      file: filePath,
    });

    // Semantic outcome events for state-changing tools (best-effort).
    const rawArgs = (args as Record<string, unknown> | undefined) ?? {};
    if (name === 'mark_complete') {
      const verdict = typeof rawArgs['action'] === 'string' ? rawArgs['action'] : 'endorse';
      const problemId = typeof rawArgs['problem_id'] === 'string' ? rawArgs['problem_id'] : '';
      if (problemId) {
        const resolutionEvent: Parameters<typeof telemetry.recordOutcome>[0] = {
          kind: 'resolution',
          ts: Date.now(),
          session_id: SESSION_ID,
          annotation: { type: 'resolution', body: verdict, problem_id: problemId },
        };
        telemetry.recordOutcome(resolutionEvent);
      }
    } else if (name === 'annotate_component') {
      // Use explicit context arg if provided; fall back to the tool's generated text.
      const contextArg = typeof rawArgs['context'] === 'string' ? rawArgs['context'] : '';
      const body = contextArg || (typeof result === 'string' ? result : '');
      const mode = typeof rawArgs['mode'] === 'string' ? rawArgs['mode'] : 'explain';
      const problemId = typeof rawArgs['problem_id'] === 'string' ? rawArgs['problem_id'] : '';
      const truncated = body.length > 1985 ? body.slice(0, 1985) + '…[truncated]' : body;
      const annotationEvent: Parameters<typeof telemetry.recordOutcome>[0] = {
        kind: 'annotation',
        ts: Date.now(),
        session_id: SESSION_ID,
        annotation: { type: mode, body: truncated, problem_id: problemId || undefined },
      };
      telemetry.recordOutcome(annotationEvent);
    } else {
      // Generic outcome payload for other state-changing tools (assign_git_changes etc.)
      const outcomePayload = extractOutcomePayload(name, rawArgs);
      if (outcomePayload) {
        telemetry.outcome({ tool_name: name, outcome_payload: outcomePayload });
      }
    }

    log('info', `Tool ${name} completed in ${duration}ms`);

    // Return MCP response
    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    await sessionManager.trackUsage(SESSION_ID, name, duration, success);

    // Fire-and-forget telemetry on failure path. error_code is the message
    // (truncated by Telemetry.record's body validator on the server side).
    {
      const err = error as { message?: string } | undefined;
      const inputRecord2 = (validatedInput as Record<string, unknown> | null | undefined) ?? {};
      const filePath2 =
        typeof inputRecord2['file_path'] === 'string' ? inputRecord2['file_path'] : undefined;
      telemetry.record({
        tool_name: name,
        success: false,
        duration_ms: duration,
        error_code: err?.message?.slice(0, 200),
        file: filePath2,
      });
    }

    // Record circuit breaker failure for API errors
    if (error && typeof error === 'object' && 'code' in error) {
      const errorObj = error as any;
      if (errorObj.code !== 'RATE_LIMIT_EXCEEDED') {
        circuitBreaker.recordFailure();
      }
    }

    log('error', `Tool ${name} failed after ${duration}ms`, { error });

    // Handle MCP errors
    if (error instanceof McpError) {
      throw error;
    }

    // Handle API client errors
    if (error && typeof error === 'object' && 'code' in error) {
      const mcpError = error as any;
      throw new McpError(
        ErrorCode.InternalError,
        mcpError.message,
        mcpError.details
      );
    }

    // Generic error
    const err = error as Error;
    throw new McpError(
      ErrorCode.InternalError,
      err.message || 'An unexpected error occurred'
    );
  }
});

/**
 * Start server
 */
async function main() {
  // Determine auth method
  const authMethod = METABOB_API_KEY ? 'api_key' : SESSION_TOKEN ? 'session_token' : 'none';

  log('info', 'Starting metabob-mcp vessel', {
    analysisAPIURL: ANALYSIS_API_URL,
    activityAPIURL: ACTIVITY_API_URL,
    sessionId: SESSION_ID,
    logLevel: LOG_LEVEL,
    auth: authMethod,
    connectionSlots: USE_CONNECTION_SLOTS,
    protocols: ['mcp:stdio', `http:resolver(port=${HEALTH_PORT})`],
  });

  // Fire-and-forget TLS fingerprint self-probe. Records first-seen
  // fingerprints in ~/.metabob/known-hosts.json and warns once on
  // changes that look like MITM (new chain root in OS trust store but
  // not bundled Mozilla roots).
  const trustSummary = getLastTrustSummary();
  if (trustSummary?.installed) {
    log('debug', 'OS trust store loaded', {
      systemCerts: trustSummary.systemCertCount,
      bundledCerts: trustSummary.bundledCertCount,
    });
  }
  try {
    // system-ca certs were merged into tls.rootCertificates by
    // installSystemTrustStoreSync — slice off the bundled prefix for the
    // probe's MITM heuristic. (If we don't know the split, we still get
    // the change-detection benefit; we just won't flag MITM as confidently.)
    const probeHosts = pickMonitoredHosts(
      [ANALYSIS_API_URL, ACTIVITY_API_URL, IDENTITY_ENDPOINT].filter((value): value is string => Boolean(value)),
    );
    for (const host of probeHosts) {
      probeHostFingerprint({ host }).catch((err) => {
        log('debug', `Cert fingerprint probe failed for ${host}`, { error: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (err) {
    log('debug', 'Cert fingerprint probe setup failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // Resolve tenant with identity.metabob.com (non-fatal; populates orgId + inline JWT)
  if (authService.hasKey() && IDENTITY_ENDPOINT) {
    log('info', `Resolving tenant with identity-vessel (${IDENTITY_ENDPOINT})...`);
    await authService.resolveTenant(IDENTITY_ENDPOINT);
    if (authService.isResolved()) {
      log('info', `Tenant resolved: orgId=${authService.getOrgId()}`);
    } else {
      log('warn', 'Tenant resolution incomplete — vessel discovery will use raw ApiKey auth');
    }
    // Periodic re-resolve = key-issuance heartbeat that identity-vessel uses
    // to monitor metabob-mcp usage during the interim period.
    authService.startKeyHeartbeat(5 * 60_000, IDENTITY_ENDPOINT);
  } else if (authService.hasKey() && DISCOVERY_ENDPOINT) {
    log('info', 'Discovery-only substrate mode: skipping identity-vessel auto-resolution without an explicit IDENTITY_ENDPOINT');
  }

  // Start vessel HTTP server (health + capabilities + impulse resolver)
  try {
    await vesselServer.start();
  } catch (error) {
    log('warn', 'Failed to start vessel HTTP server', { error });
  }

  // Authenticate with ide.metabob.com (analysis API path)
  if (METABOB_API_KEY && !VESSEL_MODE) {
    try {
      log('info', 'Authenticating with API key...');
      const authResponse = await apiClient.authenticateWithApiKey();
      log('info', 'Session created', {
        session: authResponse.session.slice(0, 8) + '…',
      });
      // Keep the opaque session token fresh against ide.metabob.com
      apiClient.startSessionRefresh();
    } catch (error) {
      const err = error as Error;
      log('error', 'API key authentication failed', { error: err.message });
      console.error(`\nAuthentication failed: ${err.message}`);
      console.error('Check that your API key is valid and not expired.');
      console.error('Get a new API key from: https://app.metabob.com/settings/api-keys\n');
      process.exit(1);
    }
  } else if (VESSEL_MODE) {
    log('info', 'Vessel mode: authenticating with raw ApiKey header against analysis-vessel', {
      analysisAPIURL: ANALYSIS_API_URL,
    });
  } else if (!SESSION_TOKEN) {
    log('warn', 'No authentication configured. Some features may be unavailable.');
    log('warn', 'Set METABOB_API_KEY (exchanged for a session token) or SESSION_TOKEN for authenticated access.');
  }

  // Check API health (optional, non-blocking)
  try {
    await apiClient.health();
    log('info', 'Analysis API health check passed');
  } catch (error) {
    log('warn', 'Analysis API health check failed (continuing anyway)', { error });
  }

  // Acquire connection slot if enabled
  if (USE_CONNECTION_SLOTS) {
    try {
      log('info', 'Acquiring connection slot...');
      const connectionInfo = await apiClient.connectWithSlot();
      if (connectionInfo) {
        log('info', 'Connection slot acquired', {
          connectionId: connectionInfo.connectionId,
          slotNumber: connectionInfo.slotNumber,
          maxSlots: connectionInfo.maxSlots,
          gracePeriodMs: connectionInfo.gracePeriodMs,
        });
      }
    } catch (error) {
      const err = error as Error;
      log('error', 'Failed to acquire connection slot', { error: err.message });
      // Continue without connection slot - tools will still work but may be rate limited
      log('warn', 'Continuing without connection slot. Some features may be limited.');
    }
  }

  // Create transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'MCP server ready');

  // ── Start sidecar workers ─────────────────────────────────────────────────
  if (SIDECAR_MODE && localStore) {
    const workspaceRoot = process.env['WORKSPACE_PATH'] ?? process.cwd();
    const workspaceId = await resolveWorkspaceId(workspaceRoot);

    // Watchers run even in anonymous mode (they just enqueue; scheduler won't drain)
    stopWatcher = startWatcher(workspaceRoot, localStore, workspaceId);
    stopGitWatcher = startGitWatcher(workspaceRoot, localStore, workspaceId);

    if (!ANONYMOUS_MODE && METABOB_API_KEY) {
      scheduler = new Scheduler(
        localStore,
        workspaceId,
        // /v2/mcp/analysis/run lives on the activity-api, not the analysis vessel.
        ACTIVITY_API_URL,
        METABOB_API_KEY,
        telemetry,
        workspaceRoot,
      );
      scheduler.start();
      log('info', '[sidecar] scheduler started', { workspaceRoot, workspaceId: workspaceId.slice(0, 8) });
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown() {
    log('info', 'Shutting down...');

    scheduler?.stop();
    stopWatcher?.();
    stopGitWatcher?.();

    authService.stopKeyHeartbeat();
    telemetry.destroy();
    localStore?.close();
    await apiClient.shutdown();
    await vesselServer.stop();
    sessionManager.stop();
    await server.close();
    process.exit(0);
  }

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run server
main().catch((error) => {
  log('error', 'Fatal error', { error });
  process.exit(1);
});
