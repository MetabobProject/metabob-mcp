/**
 * Durable execution traces, read through the attachment: the
 * `activityExecutionTrace` shape (activity-api's resolver) with `format: "json"`,
 * resolved through discovery `POST /resolve` (CONFORMANCE §c11-attachment-model).
 * Shared by execution_trace, goal_status and goal_reasoning (SPEC §execution_trace).
 *
 * activity-api answers `{ success: true, content: "<the trace row as JSON>" }`,
 * or `404 { success: false, error: "Execution trace not found: …" }` — the
 * expected answer for a satisfier-only reach, which persists no trace. The row
 * is the stored execution: its per-task sequence sits in `execution_trace.tasks`
 * (or `trace.tasks`), which `readExecutionTrace` lifts to `tasks`.
 *
 * Recent traces come from the `executionTraceList` shape (`{ limit }`), answered as
 * `{ success, content: { metadata: { rowCount, summary }, content: { traces: [...] } } }`
 * (content may be a JSON string). Each row's id is the stored record id,
 * `v_paradigm_execution_traces:⟨exec_…⟩`; `activityExecutionTrace` answers the bare
 * `exec_…` id, so both readers use that (`bareExecutionId`).
 */

import { RESOLVE_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

export type TraceRead =
  | { kind: 'ok'; trace: Record<string, any> }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/** `table:⟨exec_…⟩` (a stored record id) → `exec_…`; any other id unchanged. */
export function bareExecutionId(id: string): string {
  const m = /^[A-Za-z0-9_]+:[⟨`]([^⟩`]+)[⟩`]$/.exec(id.trim());
  return m?.[1] ?? id.trim();
}

export async function readExecutionTrace(executionId: string): Promise<TraceRead> {
  executionId = bareExecutionId(executionId);
  let res;
  try {
    res = await resolveShape(
      { type: 'activityExecutionTrace', executionId, format: 'json' },
      // activity-api does not cancel a query discovery cut, so a retry would stack another copy of it.
      { timeoutMs: RESOLVE_TIMEOUT_MS.trace, read: true, noTimeoutRetry: true },
    );
  } catch (err) {
    return {
      kind: 'error',
      message: describeResolveFailure(err, {
        noProducer: `no producer answered, or the trace ${executionId} does not exist (a satisfier-only reach persists no trace); discovery's peer forward does not say which`,
      }),
    };
  }
  if (res.status === 404) return { kind: 'not_found' };
  const body = res.body as { success?: boolean; content?: unknown; error?: string } | undefined;
  if (res.status !== 200 || body?.success === false) {
    return { kind: 'error', message: `activityExecutionTrace answered ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}` };
  }

  let row: unknown = body?.content;
  if (typeof row === 'string') {
    try {
      row = JSON.parse(row);
    } catch {
      return { kind: 'error', message: `activityExecutionTrace returned unparseable content: ${String(body?.content).slice(0, 200)}` };
    }
  }
  if (!row || typeof row !== 'object') {
    return { kind: 'error', message: 'activityExecutionTrace returned no trace object' };
  }

  const t = { ...(row as Record<string, any>) };
  if (!Array.isArray(t.tasks)) {
    const nested = t.execution_trace?.tasks ?? t.trace?.tasks;
    if (Array.isArray(nested)) t.tasks = nested;
  }
  return { kind: 'ok', trace: t };
}

export interface TraceListRow {
  executionId: string;
  templateId?: string;
  status?: string;
  durationMs?: number;
  createdAt?: string;
}

export type TraceList =
  | { kind: 'ok'; rows: TraceListRow[]; total?: number; successCount?: number; failureCount?: number }
  | { kind: 'error'; message: string };

/** The most recent execution traces, newest first, through `executionTraceList`. */
export async function listExecutionTraces(limit: number): Promise<TraceList> {
  let res;
  try {
    res = await resolveShape({ type: 'executionTraceList', limit }, { timeoutMs: RESOLVE_TIMEOUT_MS.trace, read: true, noTimeoutRetry: true });
  } catch (err) {
    return { kind: 'error', message: describeResolveFailure(err) };
  }
  const body = res.body as { success?: boolean; content?: unknown; error?: string } | undefined;
  if (res.status !== 200 || body?.success === false) {
    return { kind: 'error', message: `executionTraceList answered ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}` };
  }
  let content: any = body?.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return { kind: 'error', message: `executionTraceList returned unparseable content: ${String(body?.content).slice(0, 200)}` };
    }
  }
  const traces = content?.content?.traces ?? content?.traces;
  if (!Array.isArray(traces)) return { kind: 'error', message: 'executionTraceList returned no trace list' };
  const rows = traces.map((r: any): TraceListRow => ({
    executionId: bareExecutionId(String(r?.pointer?.executionId ?? r?.id ?? r?.execution_id ?? '?')),
    templateId: r?.templateId ?? r?.activity_template_id ?? r?.activityId ?? r?.activity_id,
    status: r?.status,
    durationMs: typeof r?.duration_ms === 'number' ? r.duration_ms : undefined,
    createdAt: r?.created_at,
  }));
  const meta = content?.metadata;
  return {
    kind: 'ok',
    rows,
    total: typeof meta?.rowCount === 'number' ? meta.rowCount : undefined,
    successCount: meta?.summary?.successCount,
    failureCount: meta?.summary?.failureCount,
  };
}

/**
 * Whether an execution is a satisfier reach, which persists no task trace: goal-host closes the walk itself
 * (`walk-satisfier-…` ids, `satisfier:` templates), so activityExecutionTrace answers 404 for it, a successful
 * one included. Its walk is in the dispatch record (goal_reasoning), not in a trace.
 */
export function isSatisfierExecution(executionId: string | undefined | null, templateId?: string | null): boolean {
  return /^walk-satisfier-/.test(String(executionId ?? '')) || /^satisfier:/.test(String(templateId ?? ''));
}
