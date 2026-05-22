/**
 * Fire-and-forget MCP usage telemetry.
 *
 * After each tool call (success or failure), `record()` queues one event and
 * triggers an async flush against `${USER_VESSEL_URL}/v2/mcp/usage`. Failures
 * never propagate to the tool result — telemetry is best-effort and must not
 * block or fail the tool dispatch.
 *
 * Disabled when `METABOB_TELEMETRY=off` or when no API key is configured.
 * Buffer is in-memory; lost on process exit (acceptable for telemetry —
 * persistence is a future capability if the data becomes load-bearing for
 * billing). See openspec/changes/2026-05-21-mcp-usage-telemetry/.
 */

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
  endpoint?: string;
  apiKey?: string;
  mcpVersion: string;
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

export class Telemetry {
  private buffer: TelemetryEvent[] = [];
  private outcomeBuffer: OutcomeEvent[] = [];
  private endpoint: string;
  private apiKey: string;
  private mcpVersion: string;
  private enabled: boolean;
  private fetchImpl: typeof fetch;
  private flushing = false;
  private flushingOutcomes = false;

  constructor(opts: TelemetryOptions) {
    this.endpoint = opts.endpoint ?? process.env.USER_VESSEL_URL ?? "https://user.metabob.com";
    this.apiKey = opts.apiKey ?? "";
    this.mcpVersion = opts.mcpVersion;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.enabled =
      process.env.METABOB_TELEMETRY !== "off" && this.apiKey.length > 0;
  }

  /** Queue an event and trigger an async flush. Returns immediately. */
  record(event: Omit<TelemetryEvent, "mcp_version"> & { mcp_version?: string }): void {
    if (!this.enabled) return;
    this.buffer.push({
      tool_name: event.tool_name,
      success: event.success,
      duration_ms: event.duration_ms,
      error_code: event.error_code,
      mcp_version: event.mcp_version ?? this.mcpVersion,
    });
    void this.flush();
  }

  /** Send buffered events one at a time. On transport failure, requeue and bail. */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const ev = this.buffer.shift()!;
        try {
          const resp = await this.fetchImpl(`${this.endpoint}/v2/mcp/usage`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `ApiKey ${this.apiKey}`,
            },
            body: JSON.stringify(ev),
          });
          if (!resp.ok && resp.status >= 500) {
            // Transient — requeue and stop. Next record() will retry.
            this.buffer.unshift(ev);
            return;
          }
          // 4xx / 204 / 200 — drop the event (no point retrying client errors).
        } catch {
          // Network failure — requeue head and bail.
          this.buffer.unshift(ev);
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Queue a semantic outcome event and trigger an async flush. Returns
   * immediately. Caller is responsible for extracting tool-specific payload
   * fields before invoking.
   */
  outcome(event: OutcomeEvent): void {
    if (!this.enabled) return;
    this.outcomeBuffer.push({
      tool_name: event.tool_name,
      outcome_payload: event.outcome_payload,
    });
    void this.flushOutcomes();
  }

  private async flushOutcomes(): Promise<void> {
    if (this.flushingOutcomes) return;
    this.flushingOutcomes = true;
    try {
      while (this.outcomeBuffer.length > 0) {
        const ev = this.outcomeBuffer.shift()!;
        try {
          const resp = await this.fetchImpl(`${this.endpoint}/v2/mcp/outcomes`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              Authorization: `ApiKey ${this.apiKey}`,
            },
            body: JSON.stringify(ev),
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

  /** Test helper — true when METABOB_TELEMETRY=off or no key. */
  isDisabled(): boolean {
    return !this.enabled;
  }

  /** Test helper — peek buffer length. */
  bufferSize(): number {
    return this.buffer.length;
  }

  /** Test helper — peek outcome buffer length. */
  outcomeBufferSize(): number {
    return this.outcomeBuffer.length;
  }
}

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
  if (!args || typeof args !== "object") return null;
  switch (toolName) {
    case "mark_complete": {
      const problem_id = args.problem_id;
      const verdict = args.verdict;
      if (typeof problem_id !== "string" || typeof verdict !== "string") return null;
      return { problem_id, verdict };
    }
    case "annotate_component": {
      const problem_id = args.problem_id;
      const kind = args.kind;
      const content = args.content;
      if (typeof problem_id !== "string" || typeof kind !== "string") return null;
      const content_summary =
        typeof content === "string" ? content.slice(0, 200) : "";
      return { problem_id, kind, content_summary };
    }
    case "assign_git_changes": {
      const changed_files = args.changed_files;
      if (!Array.isArray(changed_files)) return null;
      const capped = changed_files
        .filter((f): f is string => typeof f === "string")
        .slice(0, 20);
      return { changed_files: capped };
    }
    default:
      return null;
  }
}
