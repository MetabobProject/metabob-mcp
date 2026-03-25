/**
 * HTTP client for metabob-analysis-api
 * Handles retries, timeouts, and error transformation
 */

export interface APIClientConfig {
  baseURL: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  /** JWT token for authentication (passed to analysis-api) */
  jwtToken?: string;
  /** API key for authentication (will be exchanged for JWT) */
  apiKey?: string;
}

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

export class AnalysisAPIClient {
  private baseURL: string;
  private timeout: number;
  private retryAttempts: number;
  private retryDelayMs: number;
  private jwtToken?: string;
  private apiKey?: string;
  private tokenExpiresAt?: Date;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private authInfo?: { org_id: string; user_id: string; scopes: string[] };

  constructor(config: APIClientConfig) {
    this.baseURL = config.baseURL || 'http://localhost:8081';
    this.timeout = config.timeout || 30000;
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelayMs = config.retryDelayMs || 100;
    this.jwtToken = config.jwtToken;
    this.apiKey = config.apiKey;
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
   * Build headers for requests, including JWT if available
   */
  private buildHeaders(sessionId: string): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    };

    if (this.jwtToken) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
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
    if (response.status === 404) {
      mcpError.suggestion = 'Try using search_codebase to find the correct component ID';
    } else if (response.status === 429) {
      mcpError.suggestion = 'Wait a moment before retrying. Rate limit will reset soon.';
    } else if (response.status === 401) {
      mcpError.suggestion = 'Check that X-Session-ID header is set correctly';
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
