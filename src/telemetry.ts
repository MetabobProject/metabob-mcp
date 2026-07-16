/**
 * Fire-and-forget MCP usage telemetry.
 *
 * In sidecar mode (ANALYSIS_API_URL points to analysis-api, not ide.metabob.com),
 * events are batched and POSTed to `${ANALYSIS_API_URL}/v2/events/mcp` as a
 * `{ session_id, events }` batch every 5 seconds or when 50 events accumulate.
 *
 * In legacy mode (ANALYSIS_API_URL defaults to / points at ide.metabob.com), the
 * old single-event `POST ${USER_VESSEL_URL}/v2/mcp/usage` path is used for
 * backward compat.
 *
 * Disabled when `METABOB_TELEMETRY=off` or when no API key is configured.
 * Buffer is in-memory; events are lost on process exit (acceptable for
 * volume-only usage telemetry). See openspec/changes/2026-05-21-mcp-usage-telemetry/
 * and openspec/changes/2026-05-21-mcp-outcome-events/.
 */

// ── Event types ───────────────────────────────────────────────────────────────

export type McpEvent =
  | {
      kind: 'tool_call';
      ts: number;
      session_id: string;
      tool_name: string;
      success: boolean;
      duration_ms?: number;
      error_code?: string;
      file?: string;
      mcp_version?: string;
    }
  | {
      kind: 'seed_read';
      ts: number;
      session_id: string;
      seed_id: string;
      tool_name: string;
    }
  | {
      kind: 'annotation';
      ts: number;
      session_id: string;
      annotation: {
        type: string;
        body: string;
        problem_id?: string;
        refs?: { files?: string[]; commit_hashes?: string[] };
      };
    }
  | {
      kind: 'resolution';
      ts: number;
      session_id: string;
      annotation: {
        type: 'resolution';
        body: string;
        problem_id?: string;
      };
    };

/** Legacy per-event shape (kept for backward compat with user-vessel). */
export interface TelemetryEvent {
  tool_name: string;
  success: boolean;
  duration_ms?: number;
  error_code?: string;
  mcp_version: string;
}

export interface OutcomeEvent {
  tool_name: string;
  outcome_payload: Record<string, unknown>;
}

export interface TelemetryOptions {
  endpoint?: string;      // USER_VESSEL_URL (legacy path)
  analysisApiUrl?: string; // ANALYSIS_API_URL (sidecar path)
  apiKey?: string;
  mcpVersion: string;
  sessionId?: string;
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_FLUSH_INTERVAL_MS = 5_000;
const BATCH_MAX_EVENTS = 50;
import { fetchWithBearerFallback } from './auth-header.js';

const LEGACY_HOST = 'ide.metabob.com';

// ── Telemetry class ───────────────────────────────────────────────────────────

export class Telemetry {
  // Legacy buffers (user-vessel path)
  private buffer: TelemetryEvent[] = [];
  private outcomeBuffer: OutcomeEvent[] = [];

  // Sidecar batch buffer
  private batchBuffer: McpEvent[] = [];
  private batchTimer: ReturnType<typeof setInterval> | null = null;

  private endpoint: string;           // user-vessel base URL
  private analysisApiUrl: string;     // analysis-api base URL
  private apiKey: string;
  private mcpVersion: string;
  private sessionId: string;
  private enabled: boolean;
  private sidecarMode: boolean;
  private fetchImpl: typeof fetch;
  private flushing = false;
  private flushingOutcomes = false;
  private flushingBatch = false;

  constructor(opts: TelemetryOptions) {
    this.endpoint = opts.endpoint ?? process.env.USER_VESSEL_URL ?? 'https://ide.metabob.com';
    this.analysisApiUrl =
      opts.analysisApiUrl ??
      process.env.ANALYSIS_API_URL ??
      'https://ide.metabob.com';
    this.apiKey = opts.apiKey ?? '';
    this.mcpVersion = opts.mcpVersion;
    this.sessionId = opts.sessionId ?? process.env.SESSION_ID ?? 'default-session';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.enabled =
      process.env.METABOB_TELEMETRY !== 'off' && this.apiKey.length > 0;

    // Use sidecar (batch) path when not pointing at the legacy ide.metabob.com host.
    this.sidecarMode =
      process.env.METABOB_STATELESS !== 'true' &&
      !this.analysisApiUrl.includes(LEGACY_HOST);

    if (this.enabled && this.sidecarMode) {
      this.batchTimer = setInterval(() => {
        void this.flushBatch();
      }, BATCH_FLUSH_INTERVAL_MS);
      // Do not prevent process exit.
      if (this.batchTimer.unref) this.batchTimer.unref();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Queue a tool_call event. In sidecar mode uses the batch path; otherwise legacy. */
  record(
    event: Omit<TelemetryEvent, 'mcp_version'> & { mcp_version?: string; file?: string },
  ): void {
    if (!this.enabled) return;

    if (this.sidecarMode) {
      this.batchBuffer.push({
        kind: 'tool_call',
        ts: Date.now(),
        session_id: this.sessionId,
        tool_name: event.tool_name,
        success: event.success,
        duration_ms: event.duration_ms,
        error_code: event.error_code,
        file: event.file,
        mcp_version: event.mcp_version ?? this.mcpVersion,
      });
      if (this.batchBuffer.length >= BATCH_MAX_EVENTS) {
        void this.flushBatch();
      }
      return;
    }

    // Legacy path
    this.buffer.push({
      tool_name: event.tool_name,
      success: event.success,
      duration_ms: event.duration_ms,
      error_code: event.error_code,
      mcp_version: event.mcp_version ?? this.mcpVersion,
    });
    void this.flush();
  }

  /**
   * Queue a semantic outcome event (annotation / resolution).
   * Accepts the full McpEvent (caller supplies session_id) or a partial
   * without session_id (telemetry will inject its own).
   */
  recordOutcome(event: McpEvent | Omit<McpEvent, 'session_id'>): void {
    if (!this.enabled) return;

    const fullEvent: McpEvent = 'session_id' in event
      ? (event as McpEvent)
      : ({ ...event, session_id: this.sessionId } as McpEvent);

    if (this.sidecarMode) {
      this.batchBuffer.push(fullEvent);
      if (this.batchBuffer.length >= BATCH_MAX_EVENTS) {
        void this.flushBatch();
      }
      return;
    }

    // Legacy outcome path (map to OutcomeEvent shape for user-vessel)
    if (fullEvent.kind === 'annotation' || fullEvent.kind === 'resolution') {
      const annotationEvent = fullEvent as unknown as { annotation: Record<string, unknown> };
      this.outcomeBuffer.push({
        tool_name: fullEvent.kind,
        outcome_payload: annotationEvent.annotation,
      });
      void this.flushOutcomes();
    }
  }

  /**
   * Legacy outcome method — retained for callers still using the old shape.
   * @deprecated prefer recordOutcome()
   */
  outcome(event: OutcomeEvent): void {
    if (!this.enabled) return;
    this.outcomeBuffer.push({
      tool_name: event.tool_name,
      outcome_payload: event.outcome_payload,
    });
    void this.flushOutcomes();
  }

  /** Force-flush all buffers. Useful during graceful shutdown. */
  async flush(): Promise<void> {
    if (this.sidecarMode) {
      await this.flushBatch();
      return;
    }
    await this.flushLegacy();
  }

  /** Tear down the periodic timer. */
  destroy(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  // ── Sidecar batch path ──────────────────────────────────────────────────────

  private async flushBatch(): Promise<void> {
    if (this.flushingBatch || this.batchBuffer.length === 0) return;
    this.flushingBatch = true;
    try {
      // Snapshot and clear the buffer.
      const events = this.batchBuffer.splice(0, BATCH_MAX_EVENTS);
      try {
        const url = `${this.analysisApiUrl}/v2/events/mcp`;
        const resp = await fetchWithBearerFallback({
          url,
          apiKey: this.apiKey,
          fetchImpl: this.fetchImpl,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId, events }),
          },
        });
        if (!resp.ok && resp.status >= 500) {
          // Transient server error — put events back at the head.
          this.batchBuffer.unshift(...events);
        }
        // 4xx — drop (client error, no point retrying).
      } catch {
        // Network failure — restore events.
        this.batchBuffer.unshift(...events);
      }
    } finally {
      this.flushingBatch = false;
    }
  }

  // ── Legacy path ─────────────────────────────────────────────────────────────

  private async flushLegacy(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const ev = this.buffer.shift()!;
        try {
          const resp = await fetchWithBearerFallback({
            url: `${this.endpoint}/v2/mcp/usage`,
            apiKey: this.apiKey,
            fetchImpl: this.fetchImpl,
            init: {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(ev),
            },
          });
          if (!resp.ok && resp.status >= 500) {
            this.buffer.unshift(ev);
            return;
          }
        } catch {
          this.buffer.unshift(ev);
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async flushOutcomes(): Promise<void> {
    if (this.flushingOutcomes) return;
    this.flushingOutcomes = true;
    try {
      while (this.outcomeBuffer.length > 0) {
        const ev = this.outcomeBuffer.shift()!;
        try {
          const resp = await fetchWithBearerFallback({
            url: `${this.endpoint}/v2/mcp/outcomes`,
            apiKey: this.apiKey,
            fetchImpl: this.fetchImpl,
            init: {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(ev),
            },
          });
          if (!resp.ok && resp.status >= 500) {
            this.outcomeBuffer.unshift(ev);
            return;
          }
        } catch {
          this.outcomeBuffer.unshift(ev);
          return;
        }
      }
    } finally {
      this.flushingOutcomes = false;
    }
  }

  // ── Test helpers ─────────────────────────────────────────────────────────────

  isDisabled(): boolean {
    return !this.enabled;
  }

  bufferSize(): number {
    return this.sidecarMode ? this.batchBuffer.length : this.buffer.length;
  }

  outcomeBufferSize(): number {
    return this.sidecarMode ? this.batchBuffer.filter(e => e.kind !== 'tool_call').length : this.outcomeBuffer.length;
  }
}

// ── extractOutcomePayload (legacy helper, kept for index.ts) ──────────────────

/**
 * Extract a semantic outcome payload for state-changing tools. Returns null
 * for tools that don't have an outcome to capture (read-only tools).
 *
 * - mark_complete → { problem_id, verdict }
 * - annotate_component → { problem_id, kind, content_summary } (200-char cap)
 * - assign_git_changes → { changed_files } (20-entry cap)
 */
export function extractOutcomePayload(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!args || typeof args !== 'object') return null;
  switch (toolName) {
    case 'mark_complete': {
      const problem_id = args.problem_id;
      const verdict = args.verdict;
      if (typeof problem_id !== 'string' || typeof verdict !== 'string') return null;
      return { problem_id, verdict };
    }
    case 'annotate_component': {
      const problem_id = args.problem_id;
      const kind = args.kind;
      const content = args.content;
      if (typeof problem_id !== 'string' || typeof kind !== 'string') return null;
      const content_summary =
        typeof content === 'string' ? content.slice(0, 200) : '';
      return { problem_id, kind, content_summary };
    }
    case 'assign_git_changes': {
      const changed_files = args.changed_files;
      if (!Array.isArray(changed_files)) return null;
      const capped = changed_files
        .filter((f): f is string => typeof f === 'string')
        .slice(0, 20);
      return { changed_files: capped };
    }
    default:
      return null;
  }
}
