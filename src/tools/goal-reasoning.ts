// Contract (input schema, behaviour): SPEC §goal_reasoning
/**
 * goal_reasoning — the "reason plane" for the operator (Claude Code) working
 * WITH the substrate. Given a dispatchId, reconstruct the goal-host walk's
 * decision-log so the operator can understand HOW the substrate reasoned toward
 * (or away from) the goal, not just the pass/fail roll-up `goal_status` gives.
 *
 * This is deliberately richer than goal_status: it renders the ordered per-task
 * walk sequence (each task = one walk step: resolver + tier, the shapes it
 * consumed → produced, success, and any failure_mode), plus the reach verdict
 * (completion shapes / reached tags) and the Thompson α/β the selected template
 * ran under. It is the read-only first slice of treating Claude Code as an
 * implicit vessel — the substrate becomes legible to the operator agent.
 *
 * Sources, each a shape resolved through discovery `POST /resolve`
 * (CONFORMANCE §c11-attachment-model), both best-effort:
 *   1. `goalWalkState` (src/tools/_goal-host.ts) — the dispatch record. If the
 *      goal-host has been extended to carry a structured `walkLog` (the v1.5
 *      walk-decision capture), it is rendered verbatim and is authoritative for
 *      satisfier-only reaches (which produce no template trace).
 *   2. the `activityExecutionTrace` shape through discovery (src/tools/_traces.ts) —
 *      the durable trace. For template-running walks this holds the per-task
 *      decision sequence. NOTE: vessel-resolve ("satisfier") reaches do NOT run
 *      a template, so their trace is thin/empty — in that case the reasoning
 *      lives in the walkLog (source 1) or, failing that, only in the goal-host
 *      journal. This tool says so explicitly rather than rendering an empty log.
 *
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { learningModeLine, readWalkState } from './_goal-host.js';
import { readExecutionTrace } from './_traces.js';

export const GoalReasoningTool = {
  name: 'goal_reasoning',
  description:
    "Reconstruct the goal-host walk's decision-log for a goal dispatched with run_goal_async (the 'reason plane'). Richer than goal_status: renders the ordered per-task walk steps (resolver + tier, shapes consumed → produced, success, failure_mode), the reach verdict (completion shapes / reached tags), and the Thompson alpha/beta the selected template ran under — so you can understand HOW the substrate reasoned toward the goal. If the goal reached via a direct vessel-resolve (no template ran), the trace is thin and the tool says so, surfacing the walkLog / reach tags instead.",
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

export type GoalReasoningInput = z.infer<typeof InputSchema>;

/** Render the honest reach verdict as the primary outcome line. */
function reachLine(reached: boolean | null | undefined, status?: string): string {
  if (status === 'running') return '  reached:            (running)';
  if (reached === true) return '  reached:            yes';
  if (reached === false) return '  reached:            no';
  return '  reached:            (unknown — goal-host reported no reach verdict)';
}

function shapeList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * Render the goal-host walk decision-log (raw decision lines, in walk order).
 * This is authoritative for satisfier-only reaches that produce no template
 * trace. Each line is stripped of the noisy `[goal-host-vessel] ` prefix and
 * numbered so the reasoning reads as an ordered sequence.
 */
function renderWalkLog(walkLog: string[]): string[] {
  if (!walkLog.length) return [];
  const lines = ['', 'Walk decision-log (goal-host):'];
  walkLog.forEach((raw, i) => {
    const clean = String(raw).replace(/^\[goal-host-vessel\]\s*/, '');
    lines.push(`  ${i + 1}. ${clean}`);
  });
  return lines;
}

/**
 * Render the per-task walk sequence from the durable trace. Each task is one
 * walk step: resolver/tier, consumed → produced shapes, success, failure_mode.
 * Returns { lines, taskCount } so the caller can detect a thin (satisfier) trace.
 */
async function renderTrace(executionId: string): Promise<{ lines: string[]; taskCount: number } | null> {
  const read = await readExecutionTrace(executionId);
  if (read.kind !== 'ok') return null;
  const t = read.trace;

  const tags = shapeList(t.tags);
  const stateSig = tags.find((x) => x.startsWith('state_signature:'));
  const reachTags = tags.filter((x) => x.startsWith('completion_shapes:') || x.startsWith('reached:'));

  const tasks = Array.isArray(t.tasks) ? t.tasks : [];
  const lines: string[] = [];

  if (tasks.length) {
    lines.push('', `Walk steps from trace (${tasks.length} task${tasks.length === 1 ? '' : 's'}):`);
    tasks.forEach((task: any, i: number) => {
      const resolver = task?.resolver_id ?? task?.resolver ?? '(resolver?)';
      const tier = task?.resolver_tier ? ` /${task.resolver_tier}` : '';
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
      const desc = task?.description;
      if (desc && typeof desc === 'string') lines.push(`       ${desc.slice(0, 120)}`);
    });
  }

  // Reach section (roll-up).
  const outShapes = new Set<string>();
  shapeList(t.output_impulse_shapes).forEach((x) => outShapes.add(x));
  shapeList(t.output_shapes).forEach((x) => outShapes.add(x));
  for (const task of tasks) {
    shapeList(task?.output_impulse_shapes ?? task?.output_shapes ?? task?.outputShapes).forEach((x) => outShapes.add(x));
  }

  const fm = t.failure_mode;
  const sel = t.selection;
  const alpha = sel?.alpha ?? t.alpha;
  const beta = sel?.beta ?? t.beta;

  lines.push('', 'Reach verdict:');
  lines.push(`  trace status:       ${t.status ?? '(unset)'}`);
  if (stateSig) lines.push(`  state-space:        ${stateSig}`);
  lines.push(`  produced shapes:    ${outShapes.size ? [...outShapes].join(', ') : '(none recorded)'}`);
  if (reachTags.length) lines.push(`  reach tags:         ${reachTags.join(', ')}`);
  if (fm) {
    const fmType = typeof fm === 'object' ? fm.type : fm;
    const fmReason = typeof fm === 'object' ? fm.reason : undefined;
    lines.push(`  failure mode:       ${fmType}${fmReason ? ` — ${fmReason}` : ''}`);
  }
  if (alpha != null || beta != null) lines.push(`  thompson α/β:       ${alpha ?? '?'} / ${beta ?? '?'}`);

  return { lines, taskCount: tasks.length };
}

export async function handle(input: GoalReasoningInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const read = await readWalkState(input.dispatch_id);
  if (read.kind === 'not_found') {
    return `goal_reasoning: dispatch ${input.dispatch_id} not found. The dispatch record is in-memory and capped (~100 dispatches); it may have been pruned. If you have the executionId, the durable trace is still readable with execution_trace.`;
  }
  if (read.kind === 'error') {
    return `goal_reasoning: ${read.message}`;
  }
  const record = read.record;

  const lines = [
    `Reasoning for dispatch ${record.dispatchId ?? input.dispatch_id}`,
    reachLine(record.reached, record.status),
    '  (reached = the goal verdict; status below is only the template exit status)',
    `  status:             ${record.status ?? '(unset)'}`,
    `  executionId:        ${record.executionId ?? '(pending)'}`,
    record.operator ? `  operator:           ${record.operator}` : null,
    learningModeLine(record.walkLog),
    record.selectedTemplateId ? `  selectedTemplateId: ${record.selectedTemplateId}` : null,
    record.error ? `  error:              ${record.error}` : null,
  ].filter(Boolean) as string[];

  if (record.status === 'running') {
    lines.push('', '  Still running — poll again for the decision-log.');
    return lines.join('\n');
  }

  // 1. Structured walkLog from the goal-host (v1.5 capture), if present — this
  //    is authoritative for satisfier-only reaches that produce no template trace.
  const walkLog = Array.isArray(record.walkLog) ? record.walkLog : [];
  lines.push(...renderWalkLog(walkLog));

  // 2. Per-task walk sequence from the durable trace, if an execution landed.
  let traceTaskCount = 0;
  if (record.executionId) {
    const rendered = await renderTrace(record.executionId);
    if (rendered) {
      lines.push(...rendered.lines);
      traceTaskCount = rendered.taskCount;
    }
  }

  // 3. Thin-trace honesty: if neither a walkLog nor per-task trace was available,
  //    say so and point at where the reasoning actually lives.
  if (!walkLog.length && traceTaskCount === 0) {
    lines.push(
      '',
      '  No structured decision-log available for this dispatch.',
      '  Likely a direct vessel-resolve ("satisfier") reach — no template ran, so the',
      '  activity-api trace is thin. The step-by-step reasoning is in the goal-host walk',
      "  log (journalctl -u goal-host-vessel, grep this run's shapes). The v1.5 walkLog",
      '  capture will surface it here directly.',
    );
    if (record.stateSignature) {
      lines.push(`  state signature (dispatch): ${JSON.stringify(record.stateSignature).slice(0, 200)}`);
    }
  }

  return lines.join('\n');
}
