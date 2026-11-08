// Contract (input schema, behaviour): SPEC §execution_trace
/**
 * execution_trace — read a durable execution trace by executionId directly
 * through MCP, so an operator never has to escape to raw activity-api curls or
 * DB queries. This is the general trace reader that goal_reasoning specialises
 * (goal_reasoning starts from a dispatchId and reconstructs the walk; this one
 * takes an executionId and renders the stored trace).
 *
 * Source: the `activityExecutionTrace` shape through discovery `POST /resolve`
 * (src/tools/_traces.ts). Renders: overall status, activity_template_id,
 * composition_chain, the load-bearing tags (state_signature:, reached:,
 * completion_shapes:, operator:), and the per-task sequence (#N ✓/✗
 * resolver/tier inShapes → outShapes + any per-task failure_mode), and for a
 * goal-host walk trace its own record, `metadata.walk` (renderWalk).
 *
 * With no execution_id it lists the most recent traces (`executionTraceList`), so
 * an agent holding no id can find one to read.
 *
 * Note: satisfier-only reaches (a direct vessel-resolve, no template) persist no
 * trace — a 404 is handled gracefully by pointing at goal_reasoning's walkLog.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { isSatisfierExecution, listExecutionTraces, readExecutionTrace } from './_traces.js';

export const ExecutionTraceTool = {
  name: 'execution_trace',
  description:
    "Read a durable execution trace by executionId through the activityExecutionTrace shape (activity-api's resolver, reached through discovery), or — called with no execution_id — list the caller's org's most recent traces (id, template, status, duration, time) to find one to read. Renders overall status, activity_template_id, composition_chain, the load-bearing tags (state_signature:, reached:, completion_shapes:, operator:), the per-task walk sequence (#N ✓/✗ resolver/tier inShapes → outShapes + per-task failure_mode), and for a goal-host walk its own record (target, producers routed around, recalled concepts, unmet inputs, bound demands, output shapes). This is the general trace reader that goal_reasoning specialises. Satisfier-only reaches persist no trace — a 404 says so and points at goal_reasoning's walkLog.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      execution_id: {
        type: 'string',
        description: 'The executionId of the durable trace to read (e.g. exec_002cxza0). Omit it to list recent traces.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'With no execution_id: how many recent traces to list (1–50, default 10).',
      },
    },
  },
};

export const InputSchema = z.object({
  execution_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type ExecutionTraceInput = z.infer<typeof InputSchema>;

function shapeList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** At most `max` items, then how many more. */
function capped(items: string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(', ')}, … (${items.length - max} more)` : items.join(', ');
}

/** An item of the walk's lists as one short phrase: a string, or an object's shape/id/name. */
function walkItem(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const name = o.shape ?? o.producer ?? o.name ?? o.id ?? o.type;
    const why = o.reason ?? o.error;
    if (name !== undefined) return why !== undefined ? `${String(name)}: ${String(why)}` : String(name);
    return JSON.stringify(v).slice(0, 80);
  }
  return String(v);
}

/** `route_around.failed_producers` as `producer: reason`, whether goal-host sends a list or a map. */
function failedProducers(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(walkItem);
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([producer, why]) =>
      `${producer}: ${why && typeof why === 'object' ? walkItem(why) : String(why)}`);
  }
  return [];
}

/**
 * A goal-host walk's own record, `metadata.walk` on its trace: target, the producers
 * it routed around, recalled concepts, unmet inputs, bound demands, outputs. Each
 * list is capped, so a long walk stays a few lines. SPEC §execution_trace
 */
// @anchor render-walk
export function renderWalk(walk: Record<string, any>): string[] {
  const MAX = 8;
  const lines = ['', 'Walk:'];
  const target = shapeList(walk.target);
  if (target.length) lines.push(`  target:          ${target.join(' + ')}`);
  if (typeof walk.attempts === 'number') lines.push(`  attempts:        ${walk.attempts}`);
  const route = walk.route_around;
  if (route && typeof route === 'object') {
    const failed = failedProducers(route.failed_producers);
    if (failed.length) lines.push(`  routed around:   ${capped(failed, MAX)}`);
    const missing = route.missing_producer;
    if (missing !== undefined && missing !== null && missing !== false) {
      lines.push(`  missing producer: ${Array.isArray(missing) ? capped(missing.map(walkItem), MAX) : walkItem(missing)}`);
    }
  }
  if (Array.isArray(walk.recalled_concept_ids)) lines.push(`  recalled concepts: ${walk.recalled_concept_ids.length}`);
  const unmet = Array.isArray(walk.unmet_inputs) ? walk.unmet_inputs.map(walkItem) : [];
  lines.push(`  unmet inputs:    ${unmet.length ? capped(unmet, MAX) : 'none'}`);
  const bound = Array.isArray(walk.bound_demands) ? walk.bound_demands.map(walkItem) : [];
  lines.push(`  bound demands:   ${bound.length ? capped(bound, MAX) : 'none'}`);
  const outputs = Array.isArray(walk.outputs) ? walk.outputs : [];
  const outShapes = outputs.map((o: any) => String(o && typeof o === 'object' ? o.shape ?? o.type ?? '?' : o));
  lines.push(`  outputs:         ${outShapes.length ? capped(outShapes, MAX) : 'none'}`);
  return lines;
}

async function listRecent(limit: number): Promise<string> {
  const list = await listExecutionTraces(limit);
  if (list.kind === 'error') return `execution_trace: ${list.message}`;
  if (!list.rows.length) return 'execution_trace: no execution traces are recorded for your org yet.';
  const counts = list.successCount !== undefined || list.failureCount !== undefined
    ? ` (success ${list.successCount ?? 0}, failure ${list.failureCount ?? 0})` : '';
  const lines = [`Recent execution traces, newest first: ${list.rows.length}${counts}`];
  for (const r of list.rows) {
    const dur = r.durationMs !== undefined ? ` ${r.durationMs}ms` : '';
    const noTrace = isSatisfierExecution(r.executionId, r.templateId) ? '  (satisfier reach: no task trace; goal_reasoning on its dispatch shows the walk)' : '';
    lines.push(`  ${r.executionId}  ${r.status ?? '?'}${dur}  ${r.templateId ?? '(no template)'}${r.createdAt ? `  ${r.createdAt}` : ''}${noTrace}`);
  }
  const anySatisfier = list.rows.some((r) => isSatisfierExecution(r.executionId, r.templateId));
  lines.push('', `Read one: execution_trace { execution_id: "<id>" }.${anySatisfier ? ' Rows marked as satisfier reaches have no task trace to read.' : ''}`);
  return lines.join('\n');
}

export async function handle(input: ExecutionTraceInput, _apiClient: AnalysisAPIClient): Promise<string> {
  if (!input.execution_id) return listRecent(input.limit ?? 10);
  if (isSatisfierExecution(input.execution_id)) {
    return [
      `execution_trace: ${input.execution_id} is a satisfier reach, by its id: goal-host closes such a walk itself and`,
      '  persists no task trace for it, so activity-api was not asked. Its walk is in the dispatch record:',
      '  goal_reasoning { dispatch_id } shows it, and goal_status gives the reach verdict.',
    ].join('\n');
  }
  const read = await readExecutionTrace(input.execution_id);
  if (read.kind === 'not_found') {
    return [
      `execution_trace: no durable trace for ${input.execution_id}.`,
      '  This is expected for a satisfier-only reach (a direct vessel-resolve with no',
      "  template run) — those persist no trace. If you have the dispatchId, goal_reasoning",
      '  renders the goal-host walkLog instead.',
    ].join('\n');
  }
  if (read.kind === 'error') {
    return `execution_trace: ${read.message}`;
  }
  const t = read.trace;

  const tags = shapeList(t.tags);
  const tagLine = (prefix: string) => tags.find((x) => x.startsWith(prefix));
  const stateSig = tagLine('state_signature:');
  const reachedTag = tagLine('reached:');
  const completionTag = tagLine('completion_shapes:');
  const operatorTag = tagLine('operator:');

  const compositionChain = shapeList(t.composition_chain);

  const lines: string[] = [
    `Execution trace ${t.execution_id ?? t.id ?? input.execution_id}`,
    `  status:               ${t.status ?? '(unset)'}`,
    `  activity_template_id: ${t.activity_template_id ?? t.template_id ?? t.activity_id ?? '(none)'}`,
  ];
  if (t.vessel_id) lines.push(`  vessel_id:            ${t.vessel_id}`);
  if (compositionChain.length) {
    lines.push(`  composition_chain:    ${compositionChain.join(' → ')}`);
  }
  if (stateSig) lines.push(`  ${stateSig}`);
  if (reachedTag) lines.push(`  ${reachedTag}`);
  if (completionTag) lines.push(`  ${completionTag}`);
  if (operatorTag) lines.push(`  ${operatorTag}`);

  const overallFm = t.failure_mode;
  if (overallFm) {
    const fmType = typeof overallFm === 'object' ? overallFm.type : overallFm;
    const fmReason = typeof overallFm === 'object' ? overallFm.reason : undefined;
    lines.push(`  failure_mode:         ${fmType}${fmReason ? ` — ${fmReason}` : ''}`);
  }

  const walk = t.metadata?.walk;
  if (walk && typeof walk === 'object') lines.push(...renderWalk(walk));

  const tasks = Array.isArray(t.tasks) ? t.tasks : [];
  if (tasks.length) {
    lines.push('', `Tasks (${tasks.length}):`);
    tasks.forEach((task: any, i: number) => {
      const resolver = task?.resolver_id ?? task?.resolver ?? '(resolver?)';
      const tier = task?.resolver_tier ? `/${task.resolver_tier}` : '';
      const inS = shapeList(task?.input_shapes ?? task?.input_impulse_shapes ?? task?.inputShapes);
      const outS = shapeList(task?.output_shapes ?? task?.output_impulse_shapes ?? task?.outputShapes);
      const ok = task?.success === true ? '✓' : task?.success === false ? '✗' : '·';
      const flow = `${inS.length ? inS.join('+') : '∅'} → ${outS.length ? outS.join('+') : '∅'}`;
      lines.push(`  #${i + 1} ${ok} ${resolver}${tier}  ${flow}`);
      const fm = task?.failure_mode;
      if (fm) {
        const fmType = typeof fm === 'object' ? fm.type : fm;
        const fmReason = typeof fm === 'object' ? fm.reason : undefined;
        lines.push(`       failure: ${fmType}${fmReason ? ` — ${fmReason}` : ''}`);
      }
    });
  } else {
    lines.push('', '  (no tasks recorded — thin trace; likely a satisfier or single-shape resolve)');
  }

  return lines.join('\n');
}
