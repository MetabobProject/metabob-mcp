// Contract (input schema, behaviour): SPEC §provide_feedback
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
 * Flow, each a shape resolved through discovery `POST /resolve`
 * (CONFORMANCE §c11-attachment-model):
 *   1. `goalWalkState` (goal-host's dispatch record) → the goal text, executionId,
 *      and selectedTemplateId are auto-derived (the operator only supplies a
 *      verdict + rationale). `goal` is stored on the dispatch record for exactly this.
 *   2. `goal_verification_label_write` (activity-api's resolver)
 *      → CREATE goal_verification_labels { goal, execution_id, activity_id,
 *      verdict, confidence, notes, labeler: "human" }.
 *
 * Verdict maps operator-facing terms → oracle-corpus verdicts:
 *   reached → achieved | not_reached → not_achieved | partial → partial
 *
 * Auth: the attachment's key, which discovery forwards; activity-api exchanges
 * it for a tenant JWT so the write is org-scoped.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';
import { operatorId } from '../operator-id.js';
import { readWalkState } from './_goal-host.js';

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

export async function handle(input: ProvideFeedbackInput, _apiClient: AnalysisAPIClient): Promise<string> {
  // 1. The dispatch record (auto-derive goal / exec / template).
  const read = await readWalkState(input.dispatch_id);
  if (read.kind === 'not_found') {
    return `provide_feedback: dispatch ${input.dispatch_id} not found (records are in-memory and capped ~100). Supply an explicit goal + executionId if you still have them.`;
  }
  if (read.kind === 'error') {
    return `provide_feedback: ${read.message}`;
  }
  const record = read.record;

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

  let writeRes;
  try {
    // A write: never retried (src/attachment.ts@attachment-resolve).
    writeRes = await resolveShape(pointer, { timeoutMs: RESOLVE_TIMEOUT_MS.trace });
  } catch (err) {
    return `provide_feedback: ${describeResolveFailure(err, {
      noProducer: "no producer answered, or the producer refused the label (for example a required field it found missing); discovery's peer forward does not say which, and no label was written",
    })}`;
  }

  const parsed = writeRes.body as { success?: boolean; error?: string; content?: string } | undefined;
  if (writeRes.status !== 200 || parsed?.success === false) {
    return `provide_feedback: label write rejected (${writeRes.status}): ${parsed?.error ?? JSON.stringify(parsed).slice(0, 200)}`;
  }

  let labelId = '(unknown)';
  try {
    labelId = JSON.parse(String(parsed?.content))?.id ?? labelId;
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
