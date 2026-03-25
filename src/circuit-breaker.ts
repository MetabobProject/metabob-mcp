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
