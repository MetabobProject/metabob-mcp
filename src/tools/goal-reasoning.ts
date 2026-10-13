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
 * Sources (both best-effort, degrade gracefully):
 *   1. goal-host `GET /executions/:dispatchId` — the dispatch record. If the
 *      goal-host has been extended to carry a structured `walkLog` (the v1.5
 *      walk-decision capture), it is rendered verbatim and is authoritative for
 *      satisfier-only reaches (which produce no template trace).
 *   2. activity-api `GET /v2/activities/execution-traces/:executionId` — the
 *      durable trace. For template-running walks this holds the per-task
 *      decision sequence. NOTE: vessel-resolve ("satisfier") reaches do NOT run
 *      a template, so their trace is thin/empty — in that case the reasoning
 *      lives in the walkLog (source 1) or, failing that, only in the goal-host
 *      journal. This tool says so explicitly rather than rendering an empty log.
 *
 * Auth: vessel mode only. Re-uses METABOB_API_KEY as ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';

const POLL_TIMEOUT_MS = parseInt(process.env.GOAL_STATUS_TIMEOUT_MS || '15000', 10);

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

interface DispatchRecordResponse {
  dispatchId?: string;
  status?: string;
  executionId?: string;
  selectedTemplateId?: string;
  error?: string;
  stateSignature?: unknown;
  /** Reason-plane walk decision-log: raw goal-host decision lines, in walk order. */
  walkLog?: string[];
  /** Honest goal-reach verdict (distinct from `status`, the template exit status). */
  reached?: boolean | null;
  /** Operator identity attributed to this dispatch, if any. */
  operator?: string | null;
}

/** Render the honest reach verdict as the primary outcome line. */
function reachLine(reached: boolean | null | undefined, status?: string): string {
  if (status === 'running') return '  reached:            (running)';
  if (reached === true) return '  reached:            yes';
  if (reached === false) return '  reached:            no';
  return '  reached:            (unknown — goal-host reported no reach verdict)';
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  return headers;
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
async function renderTrace(
  activityApiUrl: string,
  executionId: string,
): Promise<{ lines: string[]; taskCount: number } | null> {
  const url = `${activityApiUrl.replace(/\/$/, '')}/v2/activities/execution-traces/${encodeURIComponent(executionId)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: authHeaders(), signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let raw: any;
  try {
    raw = await res.json();
  } catch {
    return null;
  }
  const t = raw?.trace ?? raw?.execution ?? raw;
  if (!t || typeof t !== 'object') return null;

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
  const sel = raw?.selection ?? t.selection;
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

export async function handle(input: GoalReasoningInput, apiClient: AnalysisAPIClient): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.GOAL_HOST_VESSEL_URL) {
    return 'goal_reasoning requires discovery or an explicit GOAL_HOST_VESSEL_URL.';
  }

  const baseUrl = await resolveServiceEndpointByShape({
    explicitUrl: process.env.GOAL_HOST_VESSEL_URL,
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'goal_execution',
    apiKey: process.env.METABOB_API_KEY,
  });
  if (!baseUrl) {
    return 'goal_reasoning could not find goal-host-vessel via discovery. Set GOAL_HOST_VESSEL_URL explicitly.';
  }

  const url = `${baseUrl}/executions/${encodeURIComponent(input.dispatch_id)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: authHeaders(), signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `goal_reasoning failed to reach ${url}: ${msg}`;
  }

  if (res.status === 404) {
    return `goal_reasoning: dispatch ${input.dispatch_id} not found. The dispatch record is in-memory and capped (~100 dispatches); it may have been pruned. If you have the executionId, the durable trace still lives in activity-api.`;
  }

  const text = await res.text();
  let record: DispatchRecordResponse;
  try {
    record = JSON.parse(text) as DispatchRecordResponse;
  } catch {
    return `goal_reasoning: ${res.status} (unparseable body) ${text.slice(0, 200)}`;
  }

  const lines = [
    `Reasoning for dispatch ${record.dispatchId ?? input.dispatch_id}`,
    reachLine(record.reached, record.status),
    '  (reached = the goal verdict; status below is only the template exit status)',
    `  status:             ${record.status ?? '(unset)'}`,
    `  executionId:        ${record.executionId ?? '(pending)'}`,
    record.operator ? `  operator:           ${record.operator}` : null,
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
  const activityApiUrl = apiClient.getActivityApiUrl();
  let traceTaskCount = 0;
  if (record.executionId && activityApiUrl) {
    const rendered = await renderTrace(activityApiUrl, record.executionId);
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
