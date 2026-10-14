#!/usr/bin/env node
/**
 * metabob-mcp: local code analysis and the substrate's operator cockpit,
 * exposed to AI agents over MCP stdio. A client of the substrate only.
 */

// Install OS trust store before any HTTPS fires. Idempotent — if cli.ts
// already ran this, subsequent calls are no-ops. Covers the case where
// users run `bun src/index.ts` or import this module directly.
import { installSystemTrustStoreSync } from './tls-trust.js';
installSystemTrustStoreSync({ disabled: process.env.METABOB_NO_SYSTEM_CA === '1' });

// @anchor stdout-is-transport
// stdout is the MCP transport: a client parses every line on it as JSON-RPC,
// and the stdio transport forbids anything else there. Library code logs with
// console.log (the vendored CPG prints its ONNX model load), so the console's
// stdout methods write to stderr for the life of the server.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { AnalysisAPIClient } from './api-client.js';
import { SessionManager } from './session-manager.js';
import { TOOL_REGISTRY, getAllTools, substrateToolRefusal } from './tools/index.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker, shouldTripBreaker } from './circuit-breaker.js';
import {
  VesselServer,
  isToolPermitted,
  toolAllowlistActive,
  toolNotEnabledMessage,
} from './vessel-server.js';
import { resolveVesselId, VESSEL_BASE_NAME, VESSEL_VERSION } from './vessel-identity.js';
import { setResolverIdentity } from './resolver-identity.js';
import { reconcileUndelivered } from './agent-delivery.js';
import { AuthService } from './auth-service.js';
import { pickMonitoredHosts, probeHostFingerprint } from './cert-fingerprint.js';
import { getLastTrustSummary } from './tls-trust.js';
import { LocalStore } from './local-store.js';
import { configuredSubstrateUrls, derivedDiscoveryWarning, discoveryEndpointSource, unattachedMessage } from './config.js';
import { attach, setAttachment, type Attachment } from './attachment.js';
import { translateTlsError } from './tls-error.js';
import { NetError } from './net.js';
import { ZodError } from 'zod';

// ── Configuration ── variables and defaults: CLAUDE §environment-variables ──
// Nothing defaults to a public host: an unset endpoint stays unset, and
// unattachedMessage reports it once at startup.
const METABOB_ENDPOINT = process.env.METABOB_ENDPOINT || undefined;
const DISCOVERY_ENDPOINT = process.env.DISCOVERY_ENDPOINT || undefined;

/** Stable session identifier — callers may inject SESSION_ID; otherwise a fresh UUID. */
const SESSION_ID = process.env.SESSION_ID || crypto.randomUUID();
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_REQUESTS_PER_MINUTE = Number(process.env.MAX_REQUESTS_PER_MINUTE) || 60;
// No fixed default port: a fixed default collides across concurrent instances,
// and 8000–8999 belong to substrate container ports (8080 is activity-api).
// Unset → ephemeral. The server binds loopback only either way.
// CONFORMANCE §c6-collisions
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 0;
const METABOB_API_KEY = process.env.METABOB_API_KEY;

// An explicit identity endpoint wins over the one /bootstrap advertises; there
// is no public default. CONFORMANCE §c4-anchoring
const IDENTITY_ENDPOINT = process.env.IDENTITY_ENDPOINT || undefined;

// The tools' context. Substrate calls go through the attachment, not through it.
const apiClient = new AnalysisAPIClient();

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

// ── Auth service (identity vessel) ───────────────────────────────────────────
const authService = new AuthService();
const identityApiKey = process.env.IDENTITY_API_KEY ?? METABOB_API_KEY;
if (identityApiKey) {
  authService.setApiKey(identityApiKey);
}

// ── Local SQLite store ───────────────────────────────────────────────────────
// Always on, with or without an API key: findings and agent tasks are local.
// If it cannot open, the tools that need it say so (localStore is null).
let localStore: LocalStore | null = new LocalStore();
try {
  localStore.init();
} catch (err) {
  console.error('[warn] LocalStore init failed — local findings and the agent task queue are unavailable:', err);
  localStore = null;
}

const vesselServer = new VesselServer({
  port: HEALTH_PORT,
  apiClient,
  circuitBreaker,
  sessionId: SESSION_ID,
  apiKey: METABOB_API_KEY,
  authService,
  localStore,
});

// Create MCP server
const server = new Server(
  {
    name: VESSEL_BASE_NAME,
    version: VESSEL_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
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
/**
 * Optional server-side tool allowlist: METABOB_TOOLS=a,b,c.
 *
 * An MCP CLIENT's allowlist (Claude Code's --allowedTools) governs permission
 * PROMPTS, not availability: every tool this server lists stays callable, so a
 * client-side list cannot express "this agent must not have recall". That
 * matters for two real cases — a reviewer role that may record findings but not
 * read the org's memory, and any controlled comparison where reachability is the
 * variable under test.
 *
 * Unset (the default) lists everything, so existing deployments are unchanged.
 * The rule itself lives in vessel-server.ts and is shared with the loopback
 * HTTP resolver: one grammar, one authority. A second copy here is how the
 * enforcement split that a9bf3c7 fixed would grow back — silently, and with the
 * tests still green, because only one copy would be covered.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('debug', 'Listing tools');

  const all = getAllTools();
  const tools = all
    .filter(tool => isToolPermitted(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

  if (toolAllowlistActive()) {
    log('info', `Registered ${tools.length} of ${all.length} tools (METABOB_TOOLS allowlist active)`);
  } else {
    log('info', `Registered ${tools.length} tools`);
  }

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
    // ENFORCE the allowlist here too, not only in tools/list. A client that
    // learned a tool name elsewhere — a cached schema, a ToolSearch, a
    // hand-written call — can invoke a tool that was never listed, so hiding it
    // from the listing is not a control. Refuse by name before anything runs.
    if (!isToolPermitted(name)) {
      throw new McpError(ErrorCode.MethodNotFound, toolNotEnabledMessage(name));
    }

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
        `Substrate calls are paused after repeated upstream failures. Circuit breaker is open. Try again in ${Math.ceil(resetTime / 1000)}s.`,
        {
          // Distinct from an upstream SERVICE_UNAVAILABLE (a real 5xx): this
          // is the breaker's own rejection, and counting it as an upstream
          // failure would keep resetting lastFailureTime so the circuit could
          // never half-open under sustained traffic.
          code: 'CIRCUIT_OPEN',
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

    // The attachment gate: a substrate tool makes no keyed call until the key
    // is proven, and otherwise answers with the one named cause.
    // CONFORMANCE §c3-identity
    const refusal = await substrateToolRefusal(name);
    if (refusal) {
      await sessionManager.trackUsage(SESSION_ID, name, Date.now() - startTime, false);
      // The attachment logged this refusal once at WARN, naming the requirement,
      // when it settled (src/attachment.ts@attach); each refused call is debug.
      log('debug', `Tool ${name} refused: ${refusal}`);
      return { content: [{ type: 'text', text: refusal }], isError: true };
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

    // @anchor tls-intercepted-report
    // A rejected certificate chain is reported as TLS_INTERCEPTED, naming the
    // intercepting issuer, rather than as a bare fetch failure.
    // CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role
    const tlsError = translateTlsError(error);
    if (tlsError) {
      error = new McpError(ErrorCode.InternalError, tlsError.message, tlsError.toMcpDetails());
    } else if (error instanceof NetError) {
      // A request the network answered for (src/net.ts@net-causes): the named
      // cause is the message, and the code names it too.
      error = new McpError(ErrorCode.InternalError, error.message, {
        code: error.kind === 'tls_intercepted' ? 'TLS_INTERCEPTED' : error.kind.toUpperCase(),
        cause: error.cause_,
        via: error.details.via,
        ...(error.details.issuer ? { intercepting_issuer: error.details.issuer } : {}),
      });
    }

    // Only genuine upstream failures may open the circuit — a client-side
    // error says nothing about the substrate's health, and counting them
    // let five bad arguments lock out every tool, local ones included.
    if (shouldTripBreaker(error)) {
      circuitBreaker.recordFailure();
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
let attachment: Attachment | null = null;

async function main() {
  log('info', 'Starting metabob-mcp', {
    discovery: DISCOVERY_ENDPOINT ?? null,
    endpoint: METABOB_ENDPOINT ?? null,
    sessionId: SESSION_ID,
    logLevel: LOG_LEVEL,
    auth: METABOB_API_KEY ? 'api_key' : 'none',
    protocols: ['mcp:stdio', `http:resolver(127.0.0.1:${HEALTH_PORT || 'ephemeral'})`],
  });

  // A missing key or endpoint is reported here, once, by name — not as an
  // error from each service that would have needed it.
  const notAttached = unattachedMessage();
  if (notAttached) {
    log('warn', `${notAttached} (CONFORMANCE §c4-anchoring)`);
  }

  // Fire-and-forget TLS fingerprint self-probe of the configured https hosts.
  // Records first-seen fingerprints in ~/.metabob/known-hosts.json and warns
  // once on changes that look like MITM (new chain root in OS trust store but
  // not bundled Mozilla roots).
  const trustSummary = getLastTrustSummary();
  if (trustSummary?.installed) {
    log('debug', 'OS trust store loaded', {
      systemCerts: trustSummary.systemCertCount,
      bundledCerts: trustSummary.bundledCertCount,
    });
  }
  try {
    for (const host of pickMonitoredHosts(configuredSubstrateUrls())) {
      probeHostFingerprint({ host }).catch((err) => {
        log('debug', `Cert fingerprint probe failed for ${host}`, { error: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (err) {
    log('debug', 'Cert fingerprint probe setup failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // CONFORMANCE §c4-anchoring: a discovery URL derived from the endpoint is
  // census class H1, kept only until the installer writes it; say so once.
  const derivedWarning = derivedDiscoveryWarning();
  if (derivedWarning) {
    log('warn', derivedWarning);
  }

  // The attachment: /bootstrap → identity → org check, in the background.
  // Startup and local tools never wait on it; a substrate tool waits for it to
  // settle and then proceeds or answers with the named cause (SPEC §attachment).
  attachment = attach({
    discovery: DISCOVERY_ENDPOINT,
    discoverySource: discoveryEndpointSource(),
    key: METABOB_API_KEY,
    identityOverride: IDENTITY_ENDPOINT,
    authService,
    log: (level, message) => log(level, message),
  });
  setAttachment(attachment);

  // The vessel HTTP server (health + capabilities + impulse resolver) serves
  // local callers only: it binds 127.0.0.1, and nothing advertises it. The
  // process is a client of the substrate — it makes no discovery registration
  // and runs no overlay node (CONFORMANCE §c1-transport, CONFORMANCE §c2-endpoint,
  // CONFORMANCE §c11-attachment-model).
  try {
    await vesselServer.start();
  } catch (error) {
    log('warn', 'Failed to start the loopback HTTP resolver — continuing with MCP stdio only', { error });
  }
  // CONFORMANCE §c6-collisions
  // @anchor health-port-range-warning
  if (HEALTH_PORT >= 8000 && HEALTH_PORT <= 8999) {
    log('warn', 'HEALTH_PORT is in 8000–8999, which collides with substrate container ports', { port: HEALTH_PORT });
  }

  // The stable coordination identity: keys the local agent-task queue and the
  // authorship of recorded findings. It is never registered anywhere.
  try {
    const vesselId = await resolveVesselId({
      explicit: process.env.VESSEL_ID,
      apiKey: METABOB_API_KEY,
      workspaceRoot: process.env.WORKSPACE_PATH ?? process.cwd(),
    });
    setResolverIdentity({ vesselId });

    // Resume: deliver any answers this workspace produced in a prior session
    // that never reached the substrate (cross-session "provide info back").
    // Keyed, so it waits for the org check and runs only once the key is proven.
    if (vesselId && localStore && !notAttached && attachment) {
      const store = localStore;
      void attachment.settled()
        .then((state) => (state.cause === null ? reconcileUndelivered(apiClient, store, vesselId) : null))
        .then((r) => {
          if (r && (r.delivered || r.abandoned || r.pending)) {
            log('info', 'Reconciled prior-session resolutions', r);
          }
        })
        .catch((err) => log('warn', 'Resolution reconcile failed (will retry next session)', { error: err }));
    }
  } catch (error) {
    log('warn', 'Could not derive the coordination identity', { error });
  }

  // Create transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'MCP server ready');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  async function shutdown(reason = 'signal') {
    // stdin EOF and a signal can arrive together; only tear down once.
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'Shutting down...', { reason });

    attachment?.stop();
    localStore?.close();
    await vesselServer.stop();
    sessionManager.stop();
    await server.close();
    process.exit(0);
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // A reparented orphan is never signalled — SIGHUP is the one that may still
  // arrive when the controlling terminal goes away.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  // ── Exit on stdin EOF ─────────────────────────────────────────────────────
  // The MCP stdio contract is that the client owning stdin owns our lifetime.
  // When a client dies without signalling us, we are reparented to init and
  // stdin hits EOF — but the SDK's StdioServerTransport only ever listens for
  // 'data' and 'error', so nothing surfaces that. With the HTTP server and the
  // timers holding the event loop open, the orphan then runs forever. Watching
  // for EOF ourselves is what makes the process mortal.
  //
  // Escape hatch: set METABOB_STDIO_KEEPALIVE=1 to run headless (the loopback
  // HTTP resolver only) with stdin closed or /dev/null.
  if (process.env['METABOB_STDIO_KEEPALIVE'] !== '1') {
    const onStdinEof = () => void shutdown('stdin EOF (client closed)');
    process.stdin.on('end', onStdinEof);
    process.stdin.on('close', onStdinEof);
  }
}

// Run server
main().catch((error) => {
  log('error', 'Fatal error', { error });
  process.exit(1);
});
