// Contract (input schema, behaviour): SPEC §goal_status
/**
 * goal_status — poll a goal dispatched via run_goal_async, and (once it has an
 * executionId) hydrate the durable execution trace for status + state-space.
 *
 * Two-step view, each a shape resolved through discovery `POST /resolve`
 * (CONFORMANCE §c11-attachment-model):
 *   1. `goalWalkState` (src/tools/_goal-host.ts) — goal-host's in-memory dispatch
 *      record ({ status, executionId, selectedTemplateId, error, walkLog }). This
 *      is ephemeral (last ~100 dispatches, pruned) and authoritative for "is it
 *      still running".
 *   2. the `activityExecutionTrace` shape through discovery (src/tools/_traces.ts) —
 *      the durable trace. Best-effort hydration that surfaces the state-space
 *      signature (the `state_signature:<hash>` tag stamped at dispatch), the
 *      failure mode, produced output shapes, and Thompson α/β selection data.
 *
 * `status: "completed"` means the selected template executed — NOT that the
 * goal was reached. Goal-reach is the LLM verdict folded into the trace
 * (β-penalty + completion-shape tags); inspect the produced shapes / failure
 * mode below to judge reach.
 *
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { learningModeLine, readWalkState } from './_goal-host.js';
import { readExecutionTrace } from './_traces.js';

export const GoalStatusTool = {
  name: 'goal_status',
  description:
    "Poll a goal dispatched with run_goal_async. Poll gently: a few quick reads, then at least 10–15 s apart, and stop once the dispatch is no longer running — every read makes goal-host re-read the execution's labels. Returns the live dispatch status (running | completed | failed), the executionId + selectedTemplateId, and — once the trace lands — a hydrated view: the state-space signature it ran under, produced output shapes, failure mode, and Thompson alpha/beta for the selected template. Note: status=completed means the template executed, not that the goal was reached; read the produced shapes / failure mode to judge reach.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      dispatch_id: {
        type: 'string',
        description: 'The dispatchId returned by run_goal_async.',
      },
    },
    required: ['dispatch_id'],
  },
};

export const InputSchema = z.object({
  dispatch_id: z.string().min(1, 'dispatch_id is required'),
});

export type GoalStatusInput = z.infer<typeof InputSchema>;

/** Render the honest reach verdict as the primary outcome line. */
function reachLine(reached: boolean | null | undefined, status?: string): string {
  if (status === 'running') return '  reached:            (running)';
  if (reached === true) return '  reached:            yes';
  if (reached === false) return '  reached:            no';
  return '  reached:            (unknown — goal-host reported no reach verdict)';
}

/** Best-effort: pull the durable trace and summarise state-space + reach hints. */
async function hydrateTrace(executionId: string): Promise<string[] | null> {
  const read = await readExecutionTrace(executionId);
  if (read.kind !== 'ok') return null;
  const t = read.trace;

  const tags: string[] = Array.isArray(t.tags) ? t.tags.map(String) : [];
  const stateSig = tags.find((x) => x.startsWith('state_signature:'));
  const completionTags = tags.filter(
    (x) => x.startsWith('completion_shapes:') || x.startsWith('reached:'),
  );

  // Produced shapes: the trace's denormalised `output_impulse_shapes` is the
  // authoritative roll-up; fall back to a union over per-task output shapes.
  const outShapes = new Set<string>();
  for (const x of (Array.isArray(t.output_impulse_shapes) ? t.output_impulse_shapes : [])) {
    outShapes.add(String(x));
  }
  const tasks = Array.isArray(t.tasks) ? t.tasks : [];
  for (const task of tasks) {
    const s = task?.output_impulse_shapes ?? task?.output_shapes ?? task?.outputShapes;
    if (Array.isArray(s)) s.forEach((x: unknown) => outShapes.add(String(x)));
  }
  if (Array.isArray(t.output_shapes)) t.output_shapes.forEach((x: unknown) => outShapes.add(String(x)));

  const fm = t.failure_mode;
  const sel = t.selection;
  const alpha = sel?.alpha ?? t.alpha;
  const beta = sel?.beta ?? t.beta;

  const lines = ['', 'Hydrated trace:'];
  lines.push(`  trace status:       ${t.status ?? '(unset)'}`);
  if (stateSig) lines.push(`  state-space:        ${stateSig}`);
  lines.push(
    `  produced shapes:    ${outShapes.size ? [...outShapes].join(', ') : '(none recorded)'}`,
  );
  if (completionTags.length) lines.push(`  reach tags:         ${completionTags.join(', ')}`);
  if (fm) {
    const fmType = typeof fm === 'object' ? fm.type : fm;
    const fmReason = typeof fm === 'object' ? fm.reason : undefined;
    lines.push(`  failure mode:       ${fmType}${fmReason ? ` — ${fmReason}` : ''}`);
  }
  if (alpha != null || beta != null) {
    lines.push(`  thompson α/β:       ${alpha ?? '?'} / ${beta ?? '?'}`);
  }
  return lines;
}

export async function handle(
  input: GoalStatusInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const read = await readWalkState(input.dispatch_id);
  if (read.kind === 'not_found') {
    return `goal_status: dispatch ${input.dispatch_id} not found. The dispatch record is in-memory and capped (~100 dispatches); it may have been pruned. If you have the executionId, the durable trace is still readable with execution_trace.`;
  }
  if (read.kind === 'error') {
    return `goal_status: ${read.message}`;
  }
  const record = read.record;

  const lines = [
    `Dispatch ${record.dispatchId ?? input.dispatch_id}`,
    reachLine(record.reached, record.status),
    '  (reached = the goal verdict; status below is only the template exit status)',
    `  status:             ${record.status ?? '(unset)'}`,
    `  executionId:        ${record.executionId ?? '(pending)'}`,
    record.operator ? `  operator:           ${record.operator}` : null,
    record.selectedTemplateId ? `  selectedTemplateId: ${record.selectedTemplateId}` : null,
    record.error ? `  error:              ${record.error}` : null,
    learningModeLine(record.walkLog),
  ].filter(Boolean) as string[];

  // Hydrate once an execution exists and the run is no longer in flight.
  if (record.executionId && record.status !== 'running') {
    const hydrated = await hydrateTrace(record.executionId);
    if (hydrated) lines.push(...hydrated);
    else lines.push('', '  (trace hydration unavailable — read it with execution_trace)');
  } else if (record.status === 'running') {
    // The dispatch record carries the live walk log while running — render it.
    // A blank "poll again" over a walk that is visibly deciding things was the
    // cockpit-blindness defect (gap-cockpit-blind-while-goal-runs): the server
    // sent walkLog on every poll and this tool discarded it.
    const wl = Array.isArray(record.walkLog) ? record.walkLog.filter((x) => typeof x === 'string') : [];
    if (wl.length > 0) {
      lines.push('', `  Live walk (${wl.length} step${wl.length === 1 ? '' : 's'} so far, last ${Math.min(wl.length, 6)}):`);
      for (const step of wl.slice(-6)) lines.push(`    • ${step.slice(0, 200)}`);
      lines.push('', '  Still running — poll again for newer steps / the hydrated trace.');
    } else {
      lines.push('', '  Still running (no walk steps recorded yet) — poll again.');
    }
  }

  return lines.join('\n');
}
