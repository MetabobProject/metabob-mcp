/**
 * Circuit breaker for API failures
 * Opens circuit after consecutive failures to prevent cascading failures
 */

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
}

export enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Circuit open, rejecting requests
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

/**
 * Error codes that mean the ANALYSIS API is unhealthy. Everything else — bad
 * arguments, an unknown tool name, an allowlist refusal, a rate-limit rejection,
 * the breaker's own CIRCUIT_OPEN sentinel — says nothing about upstream and must
 * never open the circuit, or a caller passing five bad arguments locks itself
 * out of purely local tools too.
 */
const UPSTREAM_FAILURE_CODES: ReadonlySet<string> = new Set([
  'SERVICE_UNAVAILABLE',
  'API_TIMEOUT',
  'INTERNAL_ERROR',
  'TLS_INTERCEPTED',
]);

/**
 * Should this thrown error count as an upstream failure?
 *
 * Allowlist, not denylist: under-counting an unrecognised code is a far cheaper
 * mistake than the self-lockout it replaces. Discriminates on `typeof code`
 * rather than `instanceof McpError` — duplicate copies of the MCP SDK can
 * resolve in one process and instanceof does not survive that.
 */
export function shouldTripBreaker(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  // MCP-shaped: McpError.code is the numeric ErrorCode enum, so the meaningful
  // sentinel lives in the third constructor argument, `data.code`.
  if (typeof code === 'number') {
    const dataCode = (error as { data?: { code?: unknown } }).data?.code;
    return typeof dataCode === 'string' && UPSTREAM_FAILURE_CODES.has(dataCode);
  }
  // api-client MCPError (see mapStatusToMCPCode).
  if (typeof code === 'string') return UPSTREAM_FAILURE_CODES.has(code);
  return false;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold || 5,
      resetTimeout: config?.resetTimeout || 60000, // 1 minute
    };
  }

  /**
   * Check if request is allowed
   */
  isAllowed(): boolean {
    // If circuit is closed, allow request
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    // If circuit is open, check if reset timeout has passed
    if (this.state === CircuitState.OPEN) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;

      if (timeSinceLastFailure >= this.config.resetTimeout) {
        // Transition to half-open to test if service recovered
        this.state = CircuitState.HALF_OPEN;
        return true;
      }

      return false;
    }

    // Half-open: Allow one request to test
    return true;
  }

  /**
   * Record successful request
   */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  /**
   * Record failed request
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    // If in half-open state, immediately open circuit
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      return;
    }

    // If failure threshold exceeded, open circuit
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Get time until circuit reset (in ms)
   */
  getResetTime(): number {
    if (this.state !== CircuitState.OPEN) {
      return 0;
    }

    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    return Math.max(0, this.config.resetTimeout - timeSinceLastFailure);
  }

  /**
   * Reset circuit breaker state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}
