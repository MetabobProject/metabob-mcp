/**
 * HTTP client for metabob-analysis-api and metabob-activity-api
 * Handles retries, timeouts, error transformation, and connection slots
 */

import {
  ConnectionManager,
  ConnectionSlotError,
  GracePeriodExpiredError,
  type ConnectionState,
  type ConnectionInfo,
} from './connection-manager.js';
import { buildAuthHeader, fetchWithBearerFallback } from './auth-header.js';
import { MetabobTlsError, translateTlsError } from './tls-error.js';
import { buildResolverUrl, discoverFirstVesselByShape } from './discovery.js';

export interface APIClientConfig {
  baseURL: string;
  discoveryEndpoint?: string;
  /** Activity API URL (for connection slots and resolution) */
  activityApiUrl?: string;
  timeout?: number;
  /** Timeout specifically for file submission and analysis start-up */
  submitTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  /** Session token for authentication (obtained by exchanging an API key at POST /v2/auth/apikey).
   *  ide.metabob.com does NOT accept JWT signed tokens — only opaque session tokens. */
  sessionToken?: string;
  /** API key for authentication (will be exchanged for a session token) */
  apiKey?: string;
  /** Enable connection slot management */
  useConnectionSlots?: boolean;
  /** Callback when connection state changes */
  onConnectionStateChange?: (state: ConnectionState) => void;
  /**
   * Vessel mode: baseURL is a discovery-style impulse resolver
   * (e.g. substrate analysis-vessel on port 18250) rather than the legacy
   * ide.metabob.com REST surface. When true the client:
   *   - Authenticates with `Authorization: ApiKey <apiKey>` (no /session exchange)
   *   - Stubs legacy endpoints (getAnalysis/submitFiles/post/get/postFeedback)
   *     so tools can still call them without HTTP errors
   *   - Routes vessel-aware operations through `resolveShape()` → POST /resolve
   */
  vesselMode?: boolean;
}

// Re-export connection types
export {
  ConnectionManager,
  ConnectionSlotError,
  GracePeriodExpiredError,
  type ConnectionState,
  type ConnectionInfo,
};

/** Returned by POST /session — the session field is the Bearer token for all subsequent calls. */
export interface SessionResponse {
  session: string;
}

export interface AnalysisResult {
  path: string;
  category: string;
  startLine: number;
  endLine: number;
  id: string;
  summary: string;
  description: string;
  severity: string;
  discarded: boolean;
  endorsed: boolean;
  /** Detection confidence 0–1, when the backend provides it (vessel mode). */
  confidence?: number;
}

export interface AnalysisResponse {
  jobId?: string | null;
  status: 'complete' | 'pending' | 'running' | 'failed';
  results?: AnalysisResult[] | null;
  /**
   * Per-file submission outcome (vessel mode, where each file is POSTed on its
   * own). A batch in which every file was rejected reports `status: 'failed'`;
   * a PARTIAL rejection still reports 'complete' and is distinguishable from a
   * clean run only through these counts — an empty `results` alone cannot tell
   * "nothing found" from "nothing was accepted".
   */
  submitted?: number;
  failed?: number;
  failures?: Array<{ path: string; status: number }>;
}

export interface JobStatus {
  jobId: string;
  sessionId: string;
  jobType: string;
  state: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
  currentFile?: string;
  progressPercentage?: number;
  currentStep?: number;
  totalSteps?: number;
}

export interface MCPError {
  code: string;
  message: string;
  details?: unknown;
  suggestion?: string;
}

/** Prediction record for feedback tracking */
interface PredictionRecord {
  tool: string;
  predicted_files: string[];
  timestamp: Date;
}

export class AnalysisAPIClient {
  private baseURL: string;
  private discoveryEndpoint?: string;
  private activityApiUrl?: string;
  private timeout: number;
  private submitTimeoutMs: number;
  private retryAttempts: number;
  private retryDelayMs: number;
  /** Opaque session token from POST /session. NOT a JWT. */
  private sessionToken?: string;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private apiKey?: string;
  private connectionManager?: ConnectionManager;
  private useConnectionSlots: boolean;
  private onConnectionStateChange?: (state: ConnectionState) => void;
  private readonly vesselMode: boolean;
  /** Recent predictions per session for feedback tracking */
  private predictions: Map<string, PredictionRecord[]> = new Map();

  constructor(config: APIClientConfig) {
    this.baseURL = config.baseURL || 'https://ide.metabob.com';
    this.discoveryEndpoint = config.discoveryEndpoint;
    this.activityApiUrl = config.activityApiUrl;
    this.timeout = config.timeout || 30000;
    this.submitTimeoutMs = config.submitTimeoutMs || Math.max(this.timeout, 120000);
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelayMs = config.retryDelayMs || 100;
    this.sessionToken = config.sessionToken;
    this.apiKey = config.apiKey;
    this.useConnectionSlots = config.useConnectionSlots || false;
    this.onConnectionStateChange = config.onConnectionStateChange;
    this.vesselMode = config.vesselMode ?? false;

    // Initialize connection manager if activity API is configured
    if (this.activityApiUrl && this.useConnectionSlots) {
      this.connectionManager = new ConnectionManager({
        activityApiUrl: this.activityApiUrl,
        apiKey: this.apiKey,
        onStateChange: (state) => {
          console.error(`[metabob-mcp] Connection state: ${state}`);
          if (this.onConnectionStateChange) {
            this.onConnectionStateChange(state);
          }
        },
        onConnectionLost: (gracePeriodMs) => {
          console.error(`[metabob-mcp] Connection lost, grace period: ${gracePeriodMs}ms`);
        },
      });
    }
  }

  /**
   * Get connection manager (if enabled)
   */
  getConnectionManager(): ConnectionManager | undefined {
    return this.connectionManager;
  }

  /**
   * Get current connection ID (if connected)
   */
  getConnectionId(): string | undefined {
    return this.connectionManager?.getConnectionId();
  }

  hasDiscovery(): boolean {
    return Boolean(this.discoveryEndpoint);
  }

  getDiscoveryEndpoint(): string | undefined {
    return this.discoveryEndpoint;
  }

  /** Activity-API base URL (trace store + learner), if configured. Used by
   *  goal_status to hydrate a finished dispatch's execution trace. */
  getActivityApiUrl(): string | undefined {
    return this.activityApiUrl;
  }

  /**
   * Connect and acquire a slot (if connection slots enabled)
   */
  async connectWithSlot(): Promise<ConnectionInfo | undefined> {
    if (!this.connectionManager) {
      return undefined;
    }

    return this.connectionManager.connect();
  }

  /**
   * Disconnect and release slot
   */
  async disconnectSlot(): Promise<void> {
    if (this.connectionManager) {
      await this.connectionManager.disconnect();
    }
  }

  /**
   * Start execution tracking for heartbeat
   */
  startExecution(executionId: string, phase: string = 'running'): void {
    this.connectionManager?.startExecution(executionId, phase);
  }

  /**
   * End execution tracking
   */
  endExecution(): void {
    this.connectionManager?.endExecution();
  }

  /**
   * Set or update session token for authentication.
   * Pass the token returned by POST /v2/auth/apikey, not a JWT.
   */
  setSessionToken(token: string | undefined): void {
    this.sessionToken = token;
  }

  /**
   * Set API key for authentication
   */
  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
  }

  /**
   * Check if client is authenticated
   */
  isAuthenticated(): boolean {
    return !!(this.apiKey || this.sessionToken);
  }

  /** True when baseURL points at a discovery-style impulse resolver, not ide.metabob.com. */
  isVesselMode(): boolean {
    return this.vesselMode;
  }

  /**
   * POST /resolve on the analysis-vessel. Body shape matches the daemon's
   * accepted formats: `{impulse:{pointer:{type,...}}}` with ApiKey auth.
   */
  async resolveShape(shape: string, pointer: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (!this.vesselMode && !this.discoveryEndpoint) {
      throw new Error('resolveShape is only available in vessel mode or when discovery is configured');
    }

    if (this.discoveryEndpoint) {
      const discovered = await discoverFirstVesselByShape({
        discoveryEndpoint: this.discoveryEndpoint,
        shape,
        apiKey: this.apiKey,
      });

      if (discovered) {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (sessionId) headers['X-Session-ID'] = sessionId;

        if (discovered.auth_scheme === 'ApiKey' && this.apiKey) {
          headers.Authorization = `ApiKey ${this.apiKey}`;
        } else if (discovered.auth_scheme === 'Bearer' && this.sessionToken) {
          headers.Authorization = `Bearer ${this.sessionToken}`;
        }

        const body = JSON.stringify(
          discovered.resolve_request_format === 'mcp-tool'
            ? {
                tool: `${shape}_resolve`,
                arguments: { type: shape, ...pointer },
              }
            : {
                impulse: {
                  pointer: { type: shape, ...pointer },
                },
              },
        );

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          discovered.resolve_timeout_ms ?? Math.max(this.submitTimeoutMs, 120000),
        );
        try {
          const response = await fetch(buildResolverUrl(discovered, this.discoveryEndpoint), {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            throw new Error(`resolveShape(${shape}) failed: ${response.status} ${await response.text().catch(() => '')}`);
          }
          return response.json();
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      }
    }

    if (!this.vesselMode) {
      throw new Error(`No vessel advertises shape "${shape}" via discovery`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (sessionId) headers['X-Session-ID'] = sessionId;

    // analysis-vessel's tree-sitter parse path can take 30s+ per file
    // inside the substrate container, well beyond the standard 30s timeout.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(this.submitTimeoutMs, 120000));
    const resolveUrl = `${this.baseURL}/v2/impulses/resolve`;
    const body = JSON.stringify({ impulse: { pointer: { type: shape, ...pointer } } });
    try {
      const res = this.apiKey
        ? await fetchWithBearerFallback({
            url: resolveUrl,
            apiKey: this.apiKey,
            init: {
              method: 'POST',
              headers,
              body,
              signal: controller.signal,
            },
          })
        : await fetch(resolveUrl, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          });
      clearTimeout(timeoutId);
      if (!res.ok) {
        throw new Error(`resolveShape(${shape}) failed: ${res.status} ${await res.text().catch(() => '')}`);
      }
      return res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /**
   * Authenticate using an API key.
   * Calls POST /session with { apiKey } and stores the returned session token.
   * ide.metabob.com issues opaque session tokens — NOT JWTs.
   */
  async authenticateWithApiKey(): Promise<SessionResponse> {
    if (!this.apiKey) {
      throw new Error('No API key configured');
    }

    if (this.vesselMode) {
      // analysis-vessel authenticates each request with `Authorization: ApiKey <key>`.
      // No /session endpoint exists; treat the raw key as the session token.
      this.sessionToken = this.apiKey;
      return { session: this.apiKey };
    }

    const response = await fetch(`${this.baseURL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: this.apiKey, project: 'default' }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = errorData as { error?: string; message?: string; detail?: unknown };
      if (response.status === 401) {
        throw new Error(`Authentication failed: ${error.message || 'Invalid or expired API key'}`);
      }
      throw new Error(`Authentication failed (${response.status}): ${error.message || response.statusText}`);
    }

    const data = await response.json() as SessionResponse;
    this.sessionToken = data.session;
    return data;
  }

  /**
   * Start periodic re-auth against POST /session.
   * The legacy endpoint exposes no TTL, so we re-issue on a fixed cadence
   * to keep the opaque session token fresh.
   */
  startSessionRefresh(intervalMs = 30 * 60_000): void {
    if (!this.apiKey) return;
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      this.authenticateWithApiKey().catch(err => {
        console.error(`[api-client] session refresh failed: ${err instanceof Error ? err.message : err}`);
      });
    }, intervalMs);
    // Don't keep the event loop alive purely for refresh
    if (typeof (this.refreshTimer as { unref?: () => void }).unref === 'function') {
      (this.refreshTimer as { unref: () => void }).unref();
    }
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /**
   * Stop all background activities and disconnect
   */
  async shutdown(): Promise<void> {
    this.stopAutoRefresh();
    await this.disconnectSlot();
  }

  /**
   * Build headers for requests, including JWT and Connection-ID if available
   */
  private buildHeaders(sessionId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    };

    if (this.vesselMode && this.apiKey) {
      headers['Authorization'] = `ApiKey ${this.apiKey}`;
    } else if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }

    // Add connection ID if using connection slots
    const connectionId = this.connectionManager?.getConnectionId();
    if (connectionId) {
      headers['X-Connection-ID'] = connectionId;
    }

    return headers;
  }

  /**
   * HTTP POST with JSON body
   */
  async post<T>(endpoint: string, body: unknown, sessionId: string): Promise<T> {
    if (this.vesselMode) {
      // Map legacy endpoints to analysis-api equivalents; swallow unknowns.
      const VESSEL_POST_MAP: Record<string, string> = {
        '/recommend': '/v2/analysis/specs/generate',
        '/v2/analysis/learning/cochange': '/v2/analysis/learning/cochange',
        '/v2/analysis/learning/feedback': '/v2/analysis/learning/feedback',
        // '/v2/analysis/learning/tool-usage' intentionally absent — no vessel equivalent
      };
      const mappedEndpoint = VESSEL_POST_MAP[endpoint];
      if (!mappedEndpoint) return {} as T;

      let mappedBody: unknown = body;
      if (endpoint === '/recommend') {
        const b = body as Record<string, unknown>;
        mappedBody = {
          goal: b.problemId ? `Fix problem ${b.problemId}` : String(b.goal ?? ''),
          context: b.context,
        };
      }

      return this.retry(async () => {
        const url = `${this.baseURL}${mappedEndpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: this.buildHeaders(sessionId),
            body: JSON.stringify(mappedBody),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) throw await this.transformAPIError(response);
          const data = await response.json() as Record<string, unknown>;
          // Map /recommend response to expected { recommendation } shape
          if (endpoint === '/recommend') {
            const overview = data.overview as string | undefined;
            const steps = (data.steps as Array<{ description: string }> | undefined) ?? [];
            const recommendation = overview
              ? `${overview}\n\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}`
              : '(no recommendation)';
            return { recommendation } as T;
          }
          return data as T;
        } catch (error) {
          clearTimeout(timeoutId);
          throw this.handleError(error);
        }
      });
    }
    return this.retry(async () => {
      const url = `${this.baseURL}${endpoint}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.buildHeaders(sessionId),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw await this.transformAPIError(response);
        }

        return response.json() as Promise<T>;
      } catch (error) {
        clearTimeout(timeoutId);
        throw this.handleError(error);
      }
    });
  }

  /**
   * HTTP GET with query parameters
   */
  async get<T>(endpoint: string, params: Record<string, any>, sessionId: string): Promise<T> {
    if (this.vesselMode) {
      const VESSEL_GET_MAP: Record<string, string> = {
        '/metrics': '/v2/analysis/learning/metrics',
        // '/session/stats' intentionally absent — no vessel equivalent; callers handle {}
      };
      const mappedEndpoint = VESSEL_GET_MAP[endpoint];
      if (!mappedEndpoint) return {} as T;

      return this.retry(async () => {
        const url = new URL(`${this.baseURL}${mappedEndpoint}`);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
          const response = await fetch(url.toString(), {
            method: 'GET',
            headers: this.buildHeaders(sessionId),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) throw await this.transformAPIError(response);
          return response.json() as Promise<T>;
        } catch (error) {
          clearTimeout(timeoutId);
          throw this.handleError(error);
        }
      });
    }
    return this.retry(async () => {
      const url = new URL(`${this.baseURL}${endpoint}`);

      // Add query parameters
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
          // Handle array parameters (e.g., severity[]=HIGH&severity[]=CRITICAL)
          value.forEach(v => url.searchParams.append(`${key}[]`, String(v)));
        } else {
          url.searchParams.set(key, String(value));
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: this.buildHeaders(sessionId),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw await this.transformAPIError(response);
        }

        return response.json() as Promise<T>;
      } catch (error) {
        clearTimeout(timeoutId);
        throw this.handleError(error);
      }
    });
  }

  /**
   * HTTP PUT with JSON body
   */
  async put<T>(endpoint: string, body: unknown, sessionId: string): Promise<T> {
    return this.retry(async () => {
      const url = `${this.baseURL}${endpoint}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url, {
          method: 'PUT',
          headers: this.buildHeaders(sessionId),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw await this.transformAPIError(response);
        }

        return response.json() as Promise<T>;
      } catch (error) {
        clearTimeout(timeoutId);
        throw this.handleError(error);
      }
    });
  }

  /**
   * Submit files for analysis via POST /v2/submit (multipart/form-data).
   * Returns the analysis response — check status; if pending/running poll pollJob().
   */
  async submitFiles(
    files: Array<{ path: string; content: string }>,
    sessionId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<AnalysisResponse> {
    if (this.vesselMode) {
      if (files.length === 0) return { status: 'complete', results: [] };

      const timeoutMs = opts.timeoutMs ?? this.submitTimeoutMs;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const allResults: AnalysisResult[] = [];
        const failures: Array<{ path: string; status: number }> = [];
        for (const f of files) {
          const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
          const language =
            ext === 'ts' || ext === 'tsx' ? 'typescript' :
            ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs' ? 'javascript' :
            ext === 'py' ? 'python' : 'unknown';
          const body = JSON.stringify({
            request_id: crypto.randomUUID(),
            workspace_id: sessionId,
            file_path: f.path,
            excerpt: f.content.length > 12000 ? f.content.slice(0, 12000) : f.content,
            language,
            priority: 1,
          });
          // /v2/mcp/* is the activity-api's sidecar surface, not the
          // analysis vessel's — baseURL only as a last resort.
          const res = await fetchWithBearerFallback({
            url: `${this.activityApiUrl ?? this.baseURL}/v2/mcp/analysis/run`,
            apiKey: this.apiKey ?? '',
            init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal },
          });
          if (!res.ok) {
            // Every rejection is counted, 429 included: a "soft skip" is still a
            // file the backend never analyzed, and stderr is invisible to an MCP
            // client — the count is the only channel the caller can read.
            failures.push({ path: f.path, status: res.status });
            if (res.status !== 429) { // budget exhausted is expected, not an error
              console.error(`[api-client] submitFiles vessel: ${f.path} → ${res.status}`);
            }
            continue;
          }
          const data = await res.json() as { seeds?: Array<{ id: string; category: string; severity: string; brief: string; line_start: number; line_end: number; confidence?: number; refs?: string[] }> };
          for (const seed of data.seeds ?? []) {
            allResults.push({
              path: f.path, id: seed.id, category: seed.category,
              severity: seed.severity.toUpperCase(),
              summary: seed.brief, description: seed.brief,
              startLine: seed.line_start, endLine: seed.line_end,
              discarded: false, endorsed: false,
              confidence: seed.confidence,
            });
          }
        }
        clearTimeout(timeoutId);
        // Reporting 'complete' after every POST was rejected is this repo's
        // signature bug (cf. d9f71ea, postFeedback): the agent sees no stderr, so
        // an empty result set reads as an analyzed, clean workspace.
        return {
          status: failures.length === files.length ? 'failed' : 'complete',
          results: allResults,
          submitted: files.length - failures.length,
          failed: failures.length,
          failures,
        };
      } catch (error) {
        clearTimeout(timeoutId);
        throw this.handleError(error);
      }
    }
    const form = new FormData();
    for (const f of files) {
      const filename = f.path.split(/[\\/]/).pop() ?? 'file.txt';
      form.append('files', new Blob([f.content], { type: 'text/plain' }), filename);
    }

    const headers = this.buildHeaders(sessionId);
    delete (headers as Record<string, string>)['Content-Type']; // let fetch set multipart boundary

    const timeoutMs = opts.timeoutMs ?? this.submitTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/v2/submit`, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) throw await this.transformAPIError(response);
      return response.json() as Promise<AnalysisResponse>;
    } catch (error) {
      clearTimeout(timeoutId);
      throw this.handleError(error);
    }
  }

  /** GET /analysis — returns current analysis results for this session. */
  async getAnalysis(sessionId: string): Promise<AnalysisResponse> {
    if (this.vesselMode) {
      // analysis-vessel has no per-session results store; callers that need
      // problem data should call resolveShape('problem_detection', ...) instead.
      return { status: 'complete', results: [] };
    }
    return this.get<AnalysisResponse>('/analysis', {}, sessionId);
  }

  /** GET /jobs/{jobId}/status — poll until complete/failed or timeout. */
  async pollJob(
    jobId: string,
    sessionId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<JobStatus> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const interval = opts.intervalMs ?? 2_000;

    while (Date.now() < deadline) {
      const status = await this.get<JobStatus>(`/jobs/${jobId}/status`, {}, sessionId);
      if (status.state === 'complete' || status.state === 'failed') return status;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Job ${jobId} did not complete within ${opts.timeoutMs ?? 120_000}ms`);
  }

  /** POST /feedback/detection — endorse or discard a problem detection. */
  async postFeedback(
    problemId: string,
    sessionId: string,
    opts: { endorsed?: boolean; discarded?: boolean } = {},
  ): Promise<void> {
    if (this.vesselMode) {
      // Seed IDs (from resolveShape / get_problems) live in mcp_seeds, not
      // analysis_problems. Record feedback as a resolution event in the MCP
      // event stream so it surfaces in the session dashboard.
      const body = opts.endorsed ? 'Fixed by operator' : 'Discarded as false positive';
      const event = {
        kind: 'resolution' as const,
        ts: Date.now(),
        session_id: sessionId,
        annotation: { type: 'resolution' as const, body, problem_id: problemId },
      };
      const res = await fetchWithBearerFallback({
        url: `${this.baseURL}/v2/events/mcp`,
        apiKey: this.apiKey ?? '',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, events: [event] }),
        },
      });
      // Surface 4xx too. Swallowing them meant an unknown / wrong-shaped
      // problem id recorded nothing and still reported "endorsed" to the
      // agent — a silent no-op behind a success message.
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Feedback recording failed (${res.status}): ${text}`);
      }
      return;
    }
    await this.post<unknown>('/feedback/detection', {
      problemId,
      endorsed: opts.endorsed,
      discarded: opts.discarded,
    }, sessionId);
  }

  /**
   * Health check endpoint
   */
  async health(): Promise<{ status: string }> {
    if (this.vesselMode) {
      const res = await fetch(`${this.baseURL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      const body = await res.json() as { status?: string };
      return { status: body.status ?? 'healthy' };
    }
    const response = await fetch(`${this.baseURL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }

    return response.json() as Promise<{ status: string }>;
  }

  // ===== Learning Loop Methods (Non-blocking) =====

  /**
   * Report co-change event to learning backend (non-blocking)
   * Called after suggest_related_changes tool is used
   */
  reportCochange(
    sessionId: string,
    changedFiles: string[],
    suggestedFiles: string[]
  ): void {
    // Fire and forget - don't block the tool response
    this.post('/v2/analysis/learning/cochange', {
      changed_files: changedFiles,
      suggested_files: suggestedFiles,
      timestamp: new Date().toISOString(),
    }, sessionId).catch(error => {
      // Log but don't throw - learning is non-critical
      console.error('[metabob-mcp] Failed to report co-change:', error);
    });
  }

  /**
   * Report tool usage to learning backend (non-blocking)
   * Called after any tool is used for pattern learning
   */
  reportToolUsage(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    outputSummary: { success: boolean; resultCount?: number; durationMs: number }
  ): void {
    // Fire and forget
    this.post('/v2/analysis/learning/tool-usage', {
      tool: toolName,
      input_summary: {
        // Don't send full input, just structure
        param_keys: Object.keys(input),
        file_count: Array.isArray(input.changed_files) ? input.changed_files.length : undefined,
      },
      output: outputSummary,
      timestamp: new Date().toISOString(),
    }, sessionId).catch(error => {
      console.error('[metabob-mcp] Failed to report tool usage:', error);
    });
  }

  /**
   * Submit prediction feedback to learning backend (non-blocking)
   * Called when actual changes are recorded vs predictions
   */
  submitFeedback(
    sessionId: string,
    feedback: {
      tool: string;
      predicted_files: string[];
      actual_files: string[];
      accuracy: number;
      timestamp: string;
    }
  ): void {
    // Fire and forget
    this.post('/v2/analysis/learning/feedback', feedback, sessionId).catch(error => {
      console.error('[metabob-mcp] Failed to submit feedback:', error);
    });
  }

  /**
   * Track a prediction for later feedback comparison
   * Called when a tool makes file predictions (e.g., suggest_related_changes)
   */
  trackPrediction(
    sessionId: string,
    tool: string,
    predictedFiles: string[]
  ): void {
    let sessionPredictions = this.predictions.get(sessionId);
    if (!sessionPredictions) {
      sessionPredictions = [];
      this.predictions.set(sessionId, sessionPredictions);
    }

    // Keep only last 10 predictions per session
    if (sessionPredictions.length >= 10) {
      sessionPredictions.shift();
    }

    sessionPredictions.push({
      tool,
      predicted_files: predictedFiles,
      timestamp: new Date(),
    });
  }

  /**
   * Record actual file changes and submit feedback for recent predictions
   * Called when a problem is marked complete or changes are committed
   */
  recordActualChangesAndSubmitFeedback(
    sessionId: string,
    actualFiles: string[]
  ): void {
    const sessionPredictions = this.predictions.get(sessionId);
    if (!sessionPredictions || sessionPredictions.length === 0) {
      return;
    }

    // Compare with recent predictions (last 30 minutes)
    const now = Date.now();
    const recentPredictions = sessionPredictions.filter(p => {
      const ageMs = now - p.timestamp.getTime();
      return ageMs < 30 * 60 * 1000;
    });

    for (const prediction of recentPredictions) {
      // Calculate accuracy
      const predictedSet = new Set(prediction.predicted_files);
      const actualSet = new Set(actualFiles);

      let matches = 0;
      for (const file of actualFiles) {
        if (predictedSet.has(file)) {
          matches++;
        }
      }

      const total = Math.max(predictedSet.size, actualSet.size);
      const accuracy = total > 0 ? matches / total : 0;

      // Submit feedback (non-blocking)
      this.submitFeedback(sessionId, {
        tool: prediction.tool,
        predicted_files: prediction.predicted_files,
        actual_files: actualFiles,
        accuracy,
        timestamp: prediction.timestamp.toISOString(),
      });
    }

    // Clear processed predictions
    this.predictions.set(sessionId, []);
  }

  /**
   * HTTP status carried by a thrown error, in whichever shape it arrived.
   *
   * `transformAPIError` throws a plain MCPError OBJECT LITERAL — not an `Error`
   * instance — and parks the status at `details.status`. The old guard tested
   * `error instanceof Error && 'status' in error`, so both conjuncts failed and
   * every 4xx was retried like a 503.
   */
  private statusOf(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const direct = (error as { status?: unknown }).status;
    if (typeof direct === 'number') return direct;
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === 'object') {
      const nested = (details as { status?: unknown }).status;
      if (typeof nested === 'number') return nested;
    }
    return undefined;
  }

  /**
   * Retry with exponential backoff
   */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on client errors (4xx) — a replay cannot succeed, and
        // postFeedback (a non-idempotent write) goes through here, so a 400 was
        // being POSTed three times.
        const status = this.statusOf(error);
        if (status !== undefined && status >= 400 && status < 500) {
          throw error;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < this.retryAttempts - 1) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Transform API error response to MCP error
   */
  private async transformAPIError(response: Response): Promise<MCPError> {
    let errorData: any;

    try {
      errorData = await response.json();
    } catch {
      errorData = { message: response.statusText };
    }

    const mcpError: MCPError = {
      code: this.mapStatusToMCPCode(response.status),
      message: errorData.message || errorData.error || 'API request failed',
      details: {
        status: response.status,
        ...errorData,
      },
    };

    // Add helpful suggestions
    if (response.status === 402) {
      mcpError.code = 'BUDGET_EXCEEDED';
      mcpError.suggestion = 'Monthly LLM token budget exhausted. Pattern matches still work. Budget resets at the date shown.';
    } else if (response.status === 404) {
      mcpError.suggestion = 'Try using search_codebase to find the correct component ID';
    } else if (response.status === 429) {
      // Check if this is a slot limit error
      if (errorData.slots_used !== undefined) {
        mcpError.code = 'SLOT_LIMIT_REACHED';
        mcpError.suggestion = `Connection slot limit reached (${errorData.slots_used}/${errorData.max_slots}). Close other connections or upgrade your plan.`;
      } else {
        mcpError.suggestion = 'Wait a moment before retrying. Rate limit will reset soon.';
      }
    } else if (response.status === 401) {
      mcpError.suggestion = 'Check that X-Session-ID header is set correctly';
    } else if (response.status === 410) {
      mcpError.code = 'GRACE_PERIOD_EXPIRED';
      mcpError.suggestion = 'Connection grace period expired. Reconnect to acquire a new slot.';
    } else if (response.status >= 500) {
      mcpError.suggestion = 'The analysis API is experiencing issues. Try again in a moment.';
    }

    return mcpError;
  }

  /**
   * Handle generic errors (network, timeout, etc.)
   */
  private handleError(error: unknown): MCPError {
    // TLS chain errors get the structured corporate-proxy diagnostic.
    const tlsTranslated = translateTlsError(error, { url: this.baseURL });
    if (tlsTranslated) {
      return {
        code: tlsTranslated.code,
        message: tlsTranslated.message,
        details: tlsTranslated.toMcpDetails(),
        suggestion: tlsTranslated.hint,
      };
    }

    if (error instanceof MetabobTlsError) {
      return {
        code: error.code,
        message: error.message,
        details: error.toMcpDetails(),
        suggestion: error.hint,
      };
    }

    if (error && typeof error === 'object' && 'code' in error) {
      // Already an MCPError
      return error as MCPError;
    }

    const err = error as Error;

    // Timeout error
    if (err.name === 'AbortError' || err.message.includes('timeout')) {
      return {
        code: 'API_TIMEOUT',
        message: 'Request to analysis API timed out',
        details: { originalError: err.message },
        suggestion: 'Try reducing the scope of your query or increasing the timeout',
      };
    }

    // Network error
    if (err.message.includes('fetch') || err.message.includes('ECONNREFUSED')) {
      return {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Cannot connect to analysis API',
        details: { originalError: err.message, baseURL: this.baseURL },
        suggestion: 'Check that the analysis API is running and accessible',
      };
    }

    // Generic error
    return {
      code: 'INTERNAL_ERROR',
      message: err.message || 'An unexpected error occurred',
      details: { originalError: err.message },
    };
  }

  /**
   * Map HTTP status codes to MCP error codes
   */
  private mapStatusToMCPCode(status: number): string {
    if (status === 400) return 'INVALID_PARAMS';
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'SERVICE_UNAVAILABLE';
    return 'INTERNAL_ERROR';
  }
}
