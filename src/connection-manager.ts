/**
 * Connection Manager for Connection Slot System
 *
 * Manages the connection lifecycle for metabob-mcp:
 * - Acquires connection slots from the activity API
 * - Maintains heartbeat to keep connection alive
 * - Handles reconnection during grace period
 * - Tracks current execution state for grace period calculation
 *
 * Connection Flow:
 * 1. acquire() - Get a connection slot
 * 2. heartbeat loop - Every 30s to maintain connection
 * 3. reconnect() - If connection lost within grace period
 * 4. release() - Clean disconnection
 */

export interface ConnectionConfig {
  /** Activity API base URL */
  activityApiUrl: string;
  /** JWT token for authentication */
  jwtToken?: string;
  /** API key for authentication (will be exchanged for JWT) */
  apiKey?: string;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Callback when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
  /** Callback when connection is lost */
  onConnectionLost?: (gracePeriodMs: number) => void;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'active' | 'grace' | 'error';

export interface ConnectionInfo {
  connectionId: string;
  sessionToken: string;
  jwtToken: string;
  slotNumber: number;
  maxSlots: number;
  gracePeriodMs: number;
  connectedAt: string;
}

export interface HeartbeatResponse {
  status: string;
  grace_period_ms: number;
  next_heartbeat_at: string;
  current_execution?: {
    execution_id: string;
    phase: string;
    started_at: string;
  };
}

export interface CurrentExecution {
  executionId: string;
  phase: string;
  startedAt: string;
}

export class ConnectionManager {
  private config: ConnectionConfig;
  private state: ConnectionState = 'disconnected';
  private connectionInfo?: ConnectionInfo;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private currentExecution?: CurrentExecution;
  private lastHeartbeatAt?: Date;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;

  constructor(config: ConnectionConfig) {
    this.config = {
      heartbeatIntervalMs: 30000, // 30 seconds
      ...config,
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get connection info (if connected)
   */
  getConnectionInfo(): ConnectionInfo | undefined {
    return this.connectionInfo;
  }

  /**
   * Get current connection ID (if connected)
   */
  getConnectionId(): string | undefined {
    return this.connectionInfo?.connectionId;
  }

  /**
   * Check if connected and active
   */
  isConnected(): boolean {
    return this.state === 'active' || this.state === 'grace';
  }

  /**
   * Connect and acquire a slot
   */
  async connect(): Promise<ConnectionInfo> {
    if (this.state === 'active') {
      return this.connectionInfo!;
    }

    this.setState('connecting');

    try {
      const response = await fetch(`${this.config.activityApiUrl}/v2/connections/acquire`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          client_type: 'metabob-mcp',
          client_version: '0.1.0',
          capabilities: ['analysis', 'resolution'],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));

        if (response.status === 429) {
          // Slot limit reached
          const err = error as { message?: string; slots_used?: number; max_slots?: number };
          throw new ConnectionSlotError(
            err.message || 'Connection slot limit reached',
            err.slots_used || 0,
            err.max_slots || 0
          );
        }

        if (response.status === 401) {
          throw new Error(`Authentication failed: ${(error as any).message || 'Invalid credentials'}`);
        }

        throw new Error(`Connection failed: ${(error as any).message || response.statusText}`);
      }

      const data = await response.json() as {
        connection_id: string;
        session_token: string;
        jwt_token: string;
        slot_number: number;
        max_slots: number;
        grace_period_ms: number;
        connected_at: string;
      };

      this.connectionInfo = {
        connectionId: data.connection_id,
        sessionToken: data.session_token,
        jwtToken: data.jwt_token,
        slotNumber: data.slot_number,
        maxSlots: data.max_slots,
        gracePeriodMs: data.grace_period_ms,
        connectedAt: data.connected_at,
      };

      // Update JWT token for subsequent requests
      if (data.jwt_token) {
        this.config.jwtToken = data.jwt_token;
      }

      this.setState('active');
      this.startHeartbeat();
      this.reconnectAttempts = 0;

      return this.connectionInfo;

    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /**
   * Reconnect using session token (within grace period)
   */
  async reconnect(): Promise<ConnectionInfo> {
    if (!this.connectionInfo?.sessionToken) {
      throw new Error('No session token available for reconnection');
    }

    this.setState('connecting');

    try {
      const response = await fetch(`${this.config.activityApiUrl}/v2/connections/reconnect`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          session_token: this.connectionInfo.sessionToken,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));

        if (response.status === 410) {
          // Grace period expired
          this.connectionInfo = undefined;
          this.setState('disconnected');
          throw new GracePeriodExpiredError('Grace period expired, must acquire new connection');
        }

        throw new Error(`Reconnection failed: ${(error as any).message || response.statusText}`);
      }

      const data = await response.json() as {
        connection_id: string;
        jwt_token: string;
        reconnected_at: string;
        grace_period_remaining_ms: number;
      };

      // Update connection info
      this.connectionInfo = {
        ...this.connectionInfo,
        connectionId: data.connection_id,
        jwtToken: data.jwt_token,
        connectedAt: data.reconnected_at,
      };

      // Update JWT token
      if (data.jwt_token) {
        this.config.jwtToken = data.jwt_token;
      }

      this.setState('active');
      this.startHeartbeat();
      this.reconnectAttempts = 0;

      return this.connectionInfo;

    } catch (error) {
      if (error instanceof GracePeriodExpiredError) {
        throw error;
      }

      // Retry reconnection with backoff
      this.reconnectAttempts++;
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.pow(2, this.reconnectAttempts) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.reconnect();
      }

      this.setState('error');
      throw error;
    }
  }

  /**
   * Disconnect and release the slot
   */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();

    if (!this.connectionInfo) {
      this.setState('disconnected');
      return;
    }

    try {
      await fetch(`${this.config.activityApiUrl}/v2/connections/release`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          connection_id: this.connectionInfo.connectionId,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      // Log but don't throw - best effort release
      console.error('[ConnectionManager] Failed to release connection:', error);
    }

    this.connectionInfo = undefined;
    this.currentExecution = undefined;
    this.setState('disconnected');
  }

  /**
   * Set current execution for heartbeat reporting
   */
  setCurrentExecution(execution: CurrentExecution | undefined): void {
    this.currentExecution = execution;
  }

  /**
   * Get current execution
   */
  getCurrentExecution(): CurrentExecution | undefined {
    return this.currentExecution;
  }

  /**
   * Start execution tracking
   */
  startExecution(executionId: string, phase: string = 'running'): void {
    this.currentExecution = {
      executionId,
      phase,
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * End execution tracking
   */
  endExecution(): void {
    this.currentExecution = undefined;
  }

  /**
   * Build request headers
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.jwtToken) {
      headers['Authorization'] = `Bearer ${this.config.jwtToken}`;
    }

    if (this.connectionInfo?.connectionId) {
      headers['X-Connection-ID'] = this.connectionInfo.connectionId;
    }

    return headers;
  }

  /**
   * Start heartbeat loop
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs!);

    // Send initial heartbeat
    this.sendHeartbeat();
  }

  /**
   * Stop heartbeat loop
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Send heartbeat to keep connection alive
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.connectionInfo) {
      return;
    }

    try {
      const response = await fetch(`${this.config.activityApiUrl}/v2/connections/heartbeat`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          connection_id: this.connectionInfo.connectionId,
          current_execution: this.currentExecution ? {
            execution_id: this.currentExecution.executionId,
            phase: this.currentExecution.phase,
            started_at: this.currentExecution.startedAt,
          } : undefined,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));

        if (response.status === 404 || response.status === 410) {
          // Connection no longer exists or expired
          this.handleConnectionLost();
          return;
        }

        console.error('[ConnectionManager] Heartbeat failed:', (error as any).message);
        return;
      }

      const data = await response.json() as HeartbeatResponse;
      this.lastHeartbeatAt = new Date();

      // Update grace period if changed
      if (data.grace_period_ms && this.connectionInfo) {
        this.connectionInfo.gracePeriodMs = data.grace_period_ms;
      }

    } catch (error) {
      console.error('[ConnectionManager] Heartbeat error:', error);

      // After multiple failures, attempt reconnection
      if (this.state === 'active') {
        this.handleConnectionLost();
      }
    }
  }

  /**
   * Handle connection loss
   */
  private handleConnectionLost(): void {
    this.stopHeartbeat();
    this.setState('grace');

    const gracePeriodMs = this.connectionInfo?.gracePeriodMs || 60000;

    if (this.config.onConnectionLost) {
      this.config.onConnectionLost(gracePeriodMs);
    }

    // Attempt automatic reconnection
    setTimeout(async () => {
      if (this.state === 'grace') {
        try {
          await this.reconnect();
        } catch (error) {
          if (error instanceof GracePeriodExpiredError) {
            // Grace period expired, need fresh connection
            this.setState('disconnected');
          } else {
            this.setState('error');
          }
        }
      }
    }, 5000); // Wait 5s before reconnecting
  }

  /**
   * Set state and notify callback
   */
  private setState(state: ConnectionState): void {
    const previousState = this.state;
    this.state = state;

    if (previousState !== state && this.config.onStateChange) {
      this.config.onStateChange(state);
    }
  }
}

/**
 * Error thrown when connection slot limit is reached
 */
export class ConnectionSlotError extends Error {
  public slotsUsed: number;
  public maxSlots: number;

  constructor(message: string, slotsUsed: number, maxSlots: number) {
    super(message);
    this.name = 'ConnectionSlotError';
    this.slotsUsed = slotsUsed;
    this.maxSlots = maxSlots;
  }
}

/**
 * Error thrown when grace period has expired
 */
export class GracePeriodExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GracePeriodExpiredError';
  }
}
