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

export interface APIClientConfig {
  baseURL: string;
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
}

export interface AnalysisResponse {
  jobId?: string | null;
  status: 'complete' | 'pending' | 'running' | 'failed';
  results?: AnalysisResult[] | null;
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
  /** Recent predictions per session for feedback tracking */
  private predictions: Map<string, PredictionRecord[]> = new Map();

  constructor(config: APIClientConfig) {
    this.baseURL = config.baseURL || 'https://ide.metabob.com';
    this.activityApiUrl = config.activityApiUrl;
    this.timeout = config.timeout || 30000;
    this.submitTimeoutMs = config.submitTimeoutMs || Math.max(this.timeout, 120000);
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelayMs = config.retryDelayMs || 100;
    this.sessionToken = config.sessionToken;
    this.apiKey = config.apiKey;
    this.useConnectionSlots = config.useConnectionSlots || false;
    this.onConnectionStateChange = config.onConnectionStateChange;

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

  /**
   * Authenticate using an API key.
   * Calls POST /session with { apiKey } and stores the returned session token.
   * ide.metabob.com issues opaque session tokens — NOT JWTs.
   */
  async authenticateWithApiKey(): Promise<SessionResponse> {
    if (!this.apiKey) {
      throw new Error('No API key configured');
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

    if (this.sessionToken) {
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
    const form = new FormData();
    for (const f of files) {
      const filename = f.path.split('/').pop() ?? 'file.txt';
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
   * Retry with exponential backoff
   */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on client errors (4xx)
        if (error instanceof Error && 'status' in error) {
          const status = (error as any).status;
          if (status >= 400 && status < 500) {
            throw error;
          }
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
