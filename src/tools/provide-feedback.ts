/**
 * provide_feedback — the "feedback plane" for the operator (Claude Code) working
 * WITH the substrate. After inspecting a goal's reasoning (goal_reasoning), the
 * operator can record a verdict on whether the goal was actually achieved. Unlike
 * out-of-band commentary, this verdict is written into the substrate's learning
 * loop as a ground-truth label in the oracle corpus (goal_verification_labels,
 * migration 101) — currently for offline audit (an obsidian-vessel reach-rate
 * note), not yet consumed by an automated reach-gate recalibration path. The
 * operator becomes an interposable verifier the substrate learns from (the S1→S2→S3
 * arc); measured feedback, not advice.
 *
 * Flow:
 *   1. goal-host `GET /executions/:dispatchId` → the goal text, executionId, and
 *      selectedTemplateId are auto-derived (the operator only supplies a verdict +
 *      rationale). `goal` is stored on the dispatch record for exactly this.
 *   2. activity-api `POST /v2/impulses/resolve` with shape `goal_verification_label_write`
 *      → CREATE goal_verification_labels { goal, execution_id, activity_id,
 *      verdict, confidence, notes, labeler: "human" }.
 *
 * Verdict maps operator-facing terms → oracle-corpus verdicts:
 *   reached → achieved | not_reached → not_achieved | partial → partial
 *
 * Auth: vessel mode only. Re-uses METABOB_API_KEY as ApiKey bearer (activity-api
 * exchanges it for a tenant JWT so the write is org-scoped).
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';
import { operatorId } from '../operator-id.js';

const TIMEOUT_MS = parseInt(process.env.GOAL_STATUS_TIMEOUT_MS || '15000', 10);

export const ProvideFeedbackTool = {
  name: 'provide_feedback',
  description:
    "The operator feedback plane: record a verdict on whether a goal dispatched with run_goal_async actually achieved its intent, recording a ground-truth label into the substrate's oracle corpus (goal_verification_labels) — currently for offline audit, not yet consumed by an automated reach-gate recalibration path. Pair with goal_reasoning: inspect the walk, then endorse or correct the outcome. Auto-derives the goal text, executionId, and template from the dispatch record — you supply verdict (reached | not_reached | partial), a rationale, and optional confidence (0..1, default 0.9).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      dispatch_id: {
        type: 'string',
        description: 'The dispatchId returned by run_goal_async.',
      },
      verdict: {
        type: 'string',
        enum: ['reached', 'not_reached', 'partial'],
        description: 'Operator verdict on whether the goal was actually achieved.',
      },
      rationale: {
        type: 'string',
        description: 'Why — the evidence/reasoning behind the verdict. Stored as the label notes.',
      },
      confidence: {
        type: 'number',
        description: 'Operator confidence in the verdict, 0..1 (default 0.9).',
      },
      goal: {
        type: 'string',
        description: 'Optional override for the goal text (only needed if the dispatch record was pruned and no longer carries it).',
      },
    },
    required: ['dispatch_id', 'verdict', 'rationale'],
  },
};

export const InputSchema = z.object({
  dispatch_id: z.string().min(1, 'dispatch_id is required'),
  verdict: z.enum(['reached', 'not_reached', 'partial']),
  rationale: z.string().min(1, 'rationale is required'),
  confidence: z.number().min(0).max(1).optional(),
  goal: z.string().optional(),
});

export type ProvideFeedbackInput = z.infer<typeof InputSchema>;

const VERDICT_MAP: Record<string, 'achieved' | 'not_achieved' | 'partial'> = {
  reached: 'achieved',
  not_reached: 'not_achieved',
  partial: 'partial',
};

interface DispatchRecordResponse {
  dispatchId?: string;
  status?: string;
  goal?: string;
  executionId?: string;
  selectedTemplateId?: string;
  error?: string;
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.METABOB_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;
  return headers;
}

export async function handle(input: ProvideFeedbackInput, apiClient: AnalysisAPIClient): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.GOAL_HOST_VESSEL_URL) {
    return 'provide_feedback requires discovery or an explicit GOAL_HOST_VESSEL_URL.';
  }
  const activityApiUrl = apiClient.getActivityApiUrl();
  if (!activityApiUrl) {
    return 'provide_feedback requires an activity-api URL to write the verification label.';
  }

  // 1. Resolve goal-host and fetch the dispatch record (auto-derive goal / exec / template).
  const goalHostUrl = await resolveServiceEndpointByShape({
    explicitUrl: process.env.GOAL_HOST_VESSEL_URL,
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'goal_execution',
    apiKey: process.env.METABOB_API_KEY,
  });
  if (!goalHostUrl) {
    return 'provide_feedback could not find goal-host-vessel via discovery. Set GOAL_HOST_VESSEL_URL explicitly.';
  }

  let record: DispatchRecordResponse = {};
  try {
    const res = await fetch(`${goalHostUrl}/executions/${encodeURIComponent(input.dispatch_id)}`, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
      return `provide_feedback: dispatch ${input.dispatch_id} not found (records are in-memory and capped ~100). Supply an explicit goal + executionId if you still have them.`;
    }
    if (res.ok) record = (await res.json()) as DispatchRecordResponse;
  } catch (err) {
    return `provide_feedback failed to reach goal-host: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (record.status === 'running') {
    return `provide_feedback: dispatch ${input.dispatch_id} is still running — wait for it to complete before recording a verdict.`;
  }

  const goal = input.goal ?? record.goal;
  const executionId = record.executionId;
  const activityId = record.selectedTemplateId;

  const missing: string[] = [];
  if (!goal) missing.push('goal (dispatch record carried none — pass the `goal` argument)');
  if (!executionId) missing.push('executionId (no execution landed for this dispatch)');
  if (!activityId) missing.push('selectedTemplateId (no template/satisfier was recorded)');
  if (missing.length) {
    return `provide_feedback cannot write a label — missing: ${missing.join('; ')}.`;
  }

  const verdict = VERDICT_MAP[input.verdict];
  const confidence = input.confidence ?? 0.9;

  // The oracle-corpus write contract has no dedicated operator field, so fold the
  // operator identity into the notes for attribution.
  const operator = operatorId();
  const notes = `${input.rationale} [operator: ${operator}]`;

  // 2. Write the oracle-corpus label via the activity-api impulse resolver.
  const pointer = {
    type: 'goal_verification_label_write',
    goal,
    execution_id: executionId,
    activity_id: activityId,
    verdict,
    confidence,
    labeler: 'human',
    notes,
  };

  let writeRes: Response;
  try {
    writeRes = await fetch(`${activityApiUrl.replace(/\/$/, '')}/v2/impulses/resolve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ impulse: { pointer } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return `provide_feedback failed to reach activity-api: ${err instanceof Error ? err.message : String(err)}`;
  }

  const text = await writeRes.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `provide_feedback: activity-api returned ${writeRes.status} (unparseable) ${text.slice(0, 200)}`;
  }

  if (!writeRes.ok || parsed?.success === false) {
    return `provide_feedback: label write rejected (${writeRes.status}): ${parsed?.error ?? text.slice(0, 200)}`;
  }

  let labelId = '(unknown)';
  try {
    labelId = JSON.parse(parsed.content)?.id ?? labelId;
  } catch { /* content may not be JSON */ }

  return [
    `Feedback recorded for dispatch ${input.dispatch_id}`,
    `  verdict:      ${input.verdict} → ${verdict} (confidence ${confidence})`,
    `  goal:         ${String(goal).slice(0, 100)}`,
    `  executionId:  ${executionId}`,
    `  activity_id:  ${activityId}`,
    `  rationale:    ${input.rationale.slice(0, 160)}`,
    `  operator:     ${operator}`,
    `  oracle label: ${labelId}`,
    '',
    '  Written to goal_verification_labels (oracle corpus) — this ground-truth verdict',
    '  is retained for offline audit; no automated reach-gate recalibration reads it yet.',
  ].join('\n');
}
