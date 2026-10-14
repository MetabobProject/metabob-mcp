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
 */

import { RESOLVE_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

export type TraceRead =
  | { kind: 'ok'; trace: Record<string, any> }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export async function readExecutionTrace(executionId: string): Promise<TraceRead> {
  let res;
  try {
    res = await resolveShape(
      { type: 'activityExecutionTrace', executionId, format: 'json' },
      { timeoutMs: RESOLVE_TIMEOUT_MS.trace, read: true },
    );
  } catch (err) {
    return { kind: 'error', message: describeResolveFailure(err) };
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
