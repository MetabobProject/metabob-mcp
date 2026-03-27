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
  retryAttempts?: number;
  retryDelayMs?: number;
  /** JWT token for authentication (passed to analysis-api) */
  jwtToken?: string;
  /** API key for authentication (will be exchanged for JWT) */
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

export interface AuthResponse {
  token: string;
  expires_at: string;
  expires_in: number;
  org_id: string;
  user_id: string;
  scopes: string[];
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
  private retryAttempts: number;
  private retryDelayMs: number;
  private jwtToken?: string;
  private apiKey?: string;
  private tokenExpiresAt?: Date;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private authInfo?: { org_id: string; user_id: string; scopes: string[] };
  private connectionManager?: ConnectionManager;
  private useConnectionSlots: boolean;
  private onConnectionStateChange?: (state: ConnectionState) => void;
  /** Recent predictions per session for feedback tracking */
  private predictions: Map<string, PredictionRecord[]> = new Map();

  constructor(config: APIClientConfig) {
    this.baseURL = config.baseURL || 'http://localhost:8081';
    this.activityApiUrl = config.activityApiUrl;
    this.timeout = config.timeout || 30000;
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelayMs = config.retryDelayMs || 100;
    this.jwtToken = config.jwtToken;
    this.apiKey = config.apiKey;
    this.useConnectionSlots = config.useConnectionSlots || false;
    this.onConnectionStateChange = config.onConnectionStateChange;

    // Initialize connection manager if activity API is configured
    if (this.activityApiUrl && this.useConnectionSlots) {
      this.connectionManager = new ConnectionManager({
        activityApiUrl: this.activityApiUrl,
        jwtToken: this.jwtToken,
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

    const info = await this.connectionManager.connect();

    // Update JWT token from connection
    if (info.jwtToken) {
      this.jwtToken = info.jwtToken;
    }

    return info;
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
   * Set or update JWT token for authentication
   */
  setJwtToken(token: string | undefined): void {
    this.jwtToken = token;
  }

  /**
   * Set API key for authentication
   */
  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey;
  }

  /**
   * Get current auth info (populated after successful authentication)
   */
  getAuthInfo(): { org_id: string; user_id: string; scopes: string[] } | undefined {
    return this.authInfo;
  }

  /**
   * Check if client is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.jwtToken && (!this.tokenExpiresAt || this.tokenExpiresAt > new Date());
  }

  /**
   * Authenticate using API key
   * Exchanges API key for JWT token and sets up auto-refresh
   */
  async authenticateWithApiKey(): Promise<AuthResponse> {
    if (!this.apiKey) {
      throw new Error('No API key configured');
    }

    const response = await fetch(`${this.baseURL}/v2/auth/apikey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.apiKey }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = errorData as { error?: string; message?: string };

      if (response.status === 401) {
        throw new Error(`API key authentication failed: ${error.message || 'Invalid or expired API key'}`);
      }

      throw new Error(`API key authentication failed: ${error.message || response.statusText}`);
    }

    const authResponse = await response.json() as AuthResponse;

    // Store token and auth info
    this.jwtToken = authResponse.token;
    this.tokenExpiresAt = new Date(authResponse.expires_at);
    this.authInfo = {
      org_id: authResponse.org_id,
      user_id: authResponse.user_id,
      scopes: authResponse.scopes,
    };

    // Schedule auto-refresh at 80% of token lifetime
    this.scheduleTokenRefresh(authResponse.expires_in);

    return authResponse;
  }

  /**
   * Schedule token refresh at 80% of token lifetime
   */
  private scheduleTokenRefresh(expiresInSeconds: number): void {
    // Clear any existing timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    // Refresh at 80% of lifetime (e.g., 12 min for 15 min token)
    const refreshInMs = expiresInSeconds * 1000 * 0.8;

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.authenticateWithApiKey();
        console.error('[metabob-mcp] Token refreshed successfully');
      } catch (error) {
        console.error('[metabob-mcp] Token refresh failed:', error);
        // Retry with exponential backoff
        this.retryTokenRefresh(1);
      }
    }, refreshInMs);
  }

  /**
   * Retry token refresh with exponential backoff
   */
  private retryTokenRefresh(attempt: number): void {
    if (attempt > 3) {
      console.error('[metabob-mcp] Token refresh failed after 3 attempts, giving up');
      return;
    }

    const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.authenticateWithApiKey();
        console.error('[metabob-mcp] Token refreshed successfully on retry');
      } catch (error) {
        console.error(`[metabob-mcp] Token refresh retry ${attempt} failed:`, error);
        this.retryTokenRefresh(attempt + 1);
      }
    }, delayMs);
  }

  /**
   * Stop auto-refresh timer (call on shutdown)
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
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

    if (this.jwtToken) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
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
