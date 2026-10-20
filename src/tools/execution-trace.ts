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
 * resolver/tier inShapes → outShapes + any per-task failure_mode).
 *
 * With no execution_id it lists the most recent traces (`executionTraceList`), so
 * an agent holding no id can find one to read.
 *
 * Note: satisfier-only reaches (a direct vessel-resolve, no template) persist no
 * trace — a 404 is handled gracefully by pointing at goal_reasoning's walkLog.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { listExecutionTraces, readExecutionTrace } from './_traces.js';

export const ExecutionTraceTool = {
  name: 'execution_trace',
  description:
    "Read a durable execution trace by executionId through the activityExecutionTrace shape (activity-api's resolver, reached through discovery), or — called with no execution_id — list the most recent traces (id, template, status, duration, time) to find one to read. Renders overall status, activity_template_id, composition_chain, the load-bearing tags (state_signature:, reached:, completion_shapes:, operator:), and the per-task walk sequence (#N ✓/✗ resolver/tier inShapes → outShapes + per-task failure_mode). This is the general trace reader that goal_reasoning specialises. Satisfier-only reaches persist no trace — a 404 says so and points at goal_reasoning's walkLog.",
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

async function listRecent(limit: number): Promise<string> {
  const list = await listExecutionTraces(limit);
  if (list.kind === 'error') return `execution_trace: ${list.message}`;
  if (!list.rows.length) return 'execution_trace: no execution traces are recorded on this substrate yet.';
  const counts = list.successCount !== undefined || list.failureCount !== undefined
    ? ` (success ${list.successCount ?? 0}, failure ${list.failureCount ?? 0})` : '';
  const lines = [`Recent execution traces, newest first: ${list.rows.length}${counts}`];
  for (const r of list.rows) {
    const dur = r.durationMs !== undefined ? ` ${r.durationMs}ms` : '';
    lines.push(`  ${r.executionId}  ${r.status ?? '?'}${dur}  ${r.templateId ?? '(no template)'}${r.createdAt ? `  ${r.createdAt}` : ''}`);
  }
  lines.push('', 'Read one: execution_trace { execution_id: "<id>" }.');
  return lines.join('\n');
}

export async function handle(input: ExecutionTraceInput, _apiClient: AnalysisAPIClient): Promise<string> {
  if (!input.execution_id) return listRecent(input.limit ?? 10);
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
    `  activity_template_id: ${t.activity_template_id ?? t.activity_id ?? '(none)'}`,
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
