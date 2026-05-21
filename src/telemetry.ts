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

export interface TelemetryOptions {
  endpoint?: string;
  apiKey?: string;
  mcpVersion: string;
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

export class Telemetry {
  private buffer: TelemetryEvent[] = [];
  private endpoint: string;
  private apiKey: string;
  private mcpVersion: string;
  private enabled: boolean;
  private fetchImpl: typeof fetch;
  private flushing = false;

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

  /** Test helper — true when METABOB_TELEMETRY=off or no key. */
  isDisabled(): boolean {
    return !this.enabled;
  }

  /** Test helper — peek buffer length. */
  bufferSize(): number {
    return this.buffer.length;
  }
}
