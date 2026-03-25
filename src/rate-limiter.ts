/**
 * Rate limiter for MCP tool calls
 * Prevents excessive API requests per session
 */

export interface RateLimiterConfig {
  requestsPerMinute: number;
  windowMs: number;
}

export class RateLimiter {
  private requests = new Map<string, number[]>();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      requestsPerMinute: config?.requestsPerMinute || 60,
      windowMs: config?.windowMs || 60000, // 1 minute
    };
  }

  /**
   * Check if request is allowed within rate limit
   * @param key - Session ID or other identifier
   * @returns true if allowed, false if rate limit exceeded
   */
  async checkLimit(key: string): Promise<boolean> {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // Remove timestamps outside the window
    const recentTimestamps = timestamps.filter(
      (t) => now - t < this.config.windowMs
    );

    // Check if limit exceeded
    if (recentTimestamps.length >= this.config.requestsPerMinute) {
      this.requests.set(key, recentTimestamps);
      return false;
    }

    // Add current timestamp
    recentTimestamps.push(now);
    this.requests.set(key, recentTimestamps);
    return true;
  }

  /**
   * Get remaining requests for a key
   */
  getRemainingRequests(key: string): number {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const recentTimestamps = timestamps.filter(
      (t) => now - t < this.config.windowMs
    );

    return Math.max(0, this.config.requestsPerMinute - recentTimestamps.length);
  }

  /**
   * Get time until rate limit resets (in ms)
   */
  getResetTime(key: string): number {
    const timestamps = this.requests.get(key) || [];
    if (timestamps.length === 0) {
      return 0;
    }

    const oldestTimestamp = Math.min(...timestamps);
    const resetTime = oldestTimestamp + this.config.windowMs;
    return Math.max(0, resetTime - Date.now());
  }

  /**
   * Clear all rate limit data
   */
  clear(): void {
    this.requests.clear();
  }

  /**
   * Clear rate limit data for specific key
   */
  clearKey(key: string): void {
    this.requests.delete(key);
  }
}
