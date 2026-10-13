// Contract (input schema, behaviour): SPEC §execution_trace
/**
 * execution_trace — read a durable execution trace by executionId directly
 * through MCP, so an operator never has to escape to raw activity-api curls or
 * DB queries. This is the general trace reader that goal_reasoning specialises
 * (goal_reasoning starts from a dispatchId and reconstructs the walk; this one
 * takes an executionId and renders the stored trace).
 *
 * Source: activity-api `GET /v2/activities/execution-traces/:executionId`.
 * Renders: overall status, activity_template_id, composition_chain, the
 * load-bearing tags (state_signature:, reached:, completion_shapes:, operator:),
 * and the per-task sequence (#N ✓/✗ resolver/tier inShapes → outShapes + any
 * per-task failure_mode).
 *
 * Note: satisfier-only reaches (a direct vessel-resolve, no template) persist no
 * trace — a 404 is handled gracefully by pointing at goal_reasoning's walkLog.
 *
 * Auth: re-uses METABOB_API_KEY as ApiKey bearer.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';

const TIMEOUT_MS = parseInt(process.env.GOAL_STATUS_TIMEOUT_MS || '15000', 10);

export const ExecutionTraceTool = {
  name: 'execution_trace',
  description:
    "Read a durable execution trace by executionId from activity-api (replaces raw `/v2/activities/execution-traces/:id` curls or DB queries). Renders overall status, activity_template_id, composition_chain, the load-bearing tags (state_signature:, reached:, completion_shapes:, operator:), and the per-task walk sequence (#N ✓/✗ resolver/tier inShapes → outShapes + per-task failure_mode). This is the general trace reader that goal_reasoning specialises. Satisfier-only reaches persist no trace — a 404 says so and points at goal_reasoning's walkLog.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      execution_id: {
        type: 'string',
        description: 'The executionId of the durable trace to read (e.g. exec_002cxza0).',
      },
    },
    required: ['execution_id'],
  },
};

export const InputSchema = z.object({
  execution_id: z.string().min(1, 'execution_id is required'),
});

export type ExecutionTraceInput = z.infer<typeof InputSchema>;

function authHeaders(): Record<string, string> {
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  return headers;
}

function shapeList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export async function handle(input: ExecutionTraceInput, apiClient: AnalysisAPIClient): Promise<string> {
  const activityApiUrl = apiClient.getActivityApiUrl();
  if (!activityApiUrl) {
    return 'execution_trace requires an activity-api URL (configure metabob.endpoint at the local substrate).';
  }

  const url = `${activityApiUrl.replace(/\/$/, '')}/v2/activities/execution-traces/${encodeURIComponent(input.execution_id)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return `execution_trace failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (res.status === 404) {
    return [
      `execution_trace: no durable trace for ${input.execution_id}.`,
      '  This is expected for a satisfier-only reach (a direct vessel-resolve with no',
      "  template run) — those persist no trace. If you have the dispatchId, goal_reasoning",
      '  renders the goal-host walkLog instead.',
    ].join('\n');
  }

  const text = await res.text();
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return `execution_trace: ${res.status} (unparseable body) ${text.slice(0, 200)}`;
  }
  if (!res.ok) {
    return `execution_trace: ${res.status} from ${url}: ${text.slice(0, 200)}`;
  }

  const t = raw?.trace ?? raw?.execution ?? raw;
  if (!t || typeof t !== 'object') {
    return `execution_trace: ${input.execution_id} returned no trace object.`;
  }

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
