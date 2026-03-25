/**
 * Manages MCP session context and usage tracking
 */

export interface SessionContext {
  sessionId: string;
  projectId?: string;
  orgId?: string;
  createdAt: Date;
  lastAccessedAt: Date;
  usageStats: {
    toolCalls: number;
    totalLatency: number;
    errors: number;
  };
}

export interface SessionManagerConfig {
  timeoutMs?: number;
  cleanupIntervalMs?: number;
}

export type Scope = 'session' | 'project' | 'org';

export interface ResolvedScope {
  sessionId: string;
  projectId?: string;
  orgId?: string;
}

export class SessionManager {
  private sessions: Map<string, SessionContext>;
  private timeoutMs: number;
  private cleanupInterval: Timer | null;

  constructor(config: SessionManagerConfig = {}) {
    this.sessions = new Map();
    this.timeoutMs = config.timeoutMs || 3600000; // 1 hour default
    this.cleanupInterval = null;

    // Start cleanup timer
    const cleanupIntervalMs = config.cleanupIntervalMs || 300000; // 5 minutes
    this.startCleanupTimer(cleanupIntervalMs);
  }

  /**
   * Get or create session context (lazy initialization)
   */
  getSession(sessionId: string): SessionContext {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        createdAt: new Date(),
        lastAccessedAt: new Date(),
        usageStats: {
          toolCalls: 0,
          totalLatency: 0,
          errors: 0,
        },
      };
      this.sessions.set(sessionId, session);
    } else {
      // Update last accessed time
      session.lastAccessedAt = new Date();
    }

    return session;
  }

  /**
   * Resolve scope to session/project/org IDs
   * For now, we don't have project/org resolution logic, so we just return sessionId
   * In the future, this could query the API to resolve hierarchical scopes
   */
  async resolveScope(sessionId: string, scope: Scope): Promise<ResolvedScope> {
    const session = this.getSession(sessionId);

    const resolved: ResolvedScope = {
      sessionId,
    };

    // For 'project' and 'org' scopes, we'd need to query the API
    // For now, we just use the session context if available
    if (scope === 'project' || scope === 'org') {
      if (session.projectId) {
        resolved.projectId = session.projectId;
      }
      if (scope === 'org' && session.orgId) {
        resolved.orgId = session.orgId;
      }
    }

    return resolved;
  }

  /**
   * Track tool usage for a session
   */
  async trackUsage(
    sessionId: string,
    tool: string,
    latency: number,
    success: boolean
  ): Promise<void> {
    const session = this.getSession(sessionId);

    session.usageStats.toolCalls++;
    session.usageStats.totalLatency += latency;

    if (!success) {
      session.usageStats.errors++;
    }

    // Update last accessed time
    session.lastAccessedAt = new Date();
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const idleTime = now - session.lastAccessedAt.getTime();

      if (idleTime > this.timeoutMs) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalToolCalls: number;
    totalErrors: number;
  } {
    const now = Date.now();
    let activeSessions = 0;
    let totalToolCalls = 0;
    let totalErrors = 0;

    for (const session of this.sessions.values()) {
      const idleTime = now - session.lastAccessedAt.getTime();

      // Consider session active if accessed in last 5 minutes
      if (idleTime < 300000) {
        activeSessions++;
      }

      totalToolCalls += session.usageStats.toolCalls;
      totalErrors += session.usageStats.errors;
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      totalToolCalls,
      totalErrors,
    };
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(intervalMs: number): void {
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.cleanupExpiredSessions();
      if (cleaned > 0) {
        console.log(`[SessionManager] Cleaned up ${cleaned} expired sessions`);
      }
    }, intervalMs);
  }

  /**
   * Stop cleanup timer (for graceful shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clear all sessions (for testing)
   */
  clear(): void {
    this.sessions.clear();
  }
}
