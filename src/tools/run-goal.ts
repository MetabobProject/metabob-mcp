// Contract (input schema, behaviour): SPEC §run_goal
/**
 * run_goal — dispatch a goal to the substrate's goal-host-vessel and wait for
 * its outcome, for short, one-shot goals.
 *
 * No request is held open for the goal (CONFORMANCE §c11-attachment-model):
 * the goal is dispatched as `goalDispatchAsync`, then its dispatch record is
 * polled as `goalWalkState` — each a short resolve through discovery
 * `POST /resolve` (src/tools/_goal-host.ts) — until it leaves `running` or the
 * polling deadline passes (`RUN_GOAL_TIMEOUT_MS`, default 290 s). Past the
 * deadline the goal keeps running on goal-host, and the tool answers with its
 * dispatchId for goal_status.
 *
 * The dispatch carries `operator: <MB_OPERATOR_ID>`, which goal-host stamps
 * into the trace's `operator:` tag.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { describeResolveFailure } from '../attachment.js';
import { operatorId } from '../operator-id.js';
import { dispatchFailure, dispatchGoal, readWalkState, type WalkState } from './_goal-host.js';

// @anchor run-goal-deadline
/** The polling deadline: how long run_goal waits for the goal before handing back its dispatchId. */
export function runGoalDeadlineMs(): number {
  return parseInt(process.env.RUN_GOAL_TIMEOUT_MS || '290000', 10);
}

/** The pause between two goalWalkState polls. */
export function runGoalPollMs(): number {
  return parseInt(process.env.RUN_GOAL_POLL_MS || '2000', 10);
}

export const RunGoalTool = {
  name: 'run_goal',
  description:
    "Dispatch a goal to the substrate's goal-host-vessel and wait for it (shape goalDispatchAsync, then polled with goalWalkState). The vessel selects a template via Thompson Sampling, executes it through ias-executor-ts, and this returns the executionId, the reach verdict and the final status. Waits up to ~290s; a goal still running then keeps running, and the reply carries its dispatchId for goal_status. For long-running goals prefer run_goal_async. Provide either goal (natural-language) or target_template_id (skip selection). Optional variables seed the execution pool; parent_execution_id + composition_chain thread cross-vessel provenance.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description:
          "Natural-language goal description. Either this or target_template_id is required.",
      },
      target_template_id: {
        type: 'string',
        description:
          'Specific activity template id to execute, bypassing Thompson selection.',
      },
      variables: {
        type: 'object',
        description:
          'Seed variables injected into the execution pool. Templates reference these as {{var}} placeholders.',
        additionalProperties: true,
      },
      parent_execution_id: {
        type: 'string',
        description:
          'Parent execution id for cross-vessel provenance (composition tracking).',
      },
      composition_chain: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Ancestor execution ids, root-first. Threads through to the trace for credit propagation.',
      },
    },
  },
};

export const InputSchema = z
  .object({
    goal: z.string().optional(),
    target_template_id: z.string().optional(),
    variables: z.record(z.unknown()).optional(),
    parent_execution_id: z.string().optional(),
    composition_chain: z.array(z.string()).optional(),
  })
  .refine((v) => Boolean(v.goal || v.target_template_id), {
    message: 'goal or target_template_id is required',
  });

export type RunGoalInput = z.infer<typeof InputSchema>;

function reachedText(reached: boolean | null | undefined): string {
  if (reached === true) return 'yes';
  if (reached === false) return 'no';
  return '(unknown — goal-host reported no reach verdict)';
}

function finished(dispatchId: string, record: WalkState, duration: number): string {
  return [
    'Goal dispatched via goalDispatchAsync, completed per goalWalkState.',
    `  dispatchId:         ${dispatchId}`,
    `  executionId:        ${record.executionId ?? '(unset)'}`,
    `  reached:            ${reachedText(record.reached)}`,
    `  status:             ${record.status ?? '(unset)'}`,
    record.selectedTemplateId ? `  selectedTemplateId: ${record.selectedTemplateId}` : null,
    record.error ? `  error:              ${record.error}` : null,
    `  duration:           ${duration}ms`,
  ].filter(Boolean).join('\n');
}

export async function handle(
  input: RunGoalInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();
  const deadline = start + runGoalDeadlineMs();
  const pollMs = runGoalPollMs();

  let answer;
  try {
    answer = await dispatchGoal({
      goal: input.goal,
      targetTemplateId: input.target_template_id,
      variables: input.variables,
      parent_execution_id: input.parent_execution_id,
      composition_chain: input.composition_chain,
      operator: operatorId(),
    });
  } catch (err) {
    return `run_goal: ${describeResolveFailure(err)}`;
  }
  if ((answer.status !== 202 && answer.status !== 200) || !answer.dispatchId) {
    return `${dispatchFailure('run_goal', answer)}\n  duration: ${Date.now() - start}ms`;
  }
  const dispatchId = answer.dispatchId;
  const pollHint = `Poll with: goal_status { "dispatch_id": "${dispatchId}" }`;

  // @anchor run-goal-poll
  for (;;) {
    const read = await readWalkState(dispatchId);
    if (read.kind === 'error') {
      return [
        `run_goal: dispatched ${dispatchId}, then could not read its state: ${read.message}`,
        pollHint,
      ].join('\n');
    }
    if (read.kind === 'not_found') {
      return [
        `run_goal: dispatched ${dispatchId}, but goal-host no longer holds its record (dispatch records are in-memory and capped).`,
        `  duration: ${Date.now() - start}ms`,
      ].join('\n');
    }
    if (read.record.status !== 'running') {
      return finished(dispatchId, read.record, Date.now() - start);
    }
    if (Date.now() + pollMs >= deadline) {
      return [
        `Goal dispatched via goalDispatchAsync, still running at the ${runGoalDeadlineMs()}ms deadline (RUN_GOAL_TIMEOUT_MS); it keeps running on goal-host.`,
        `  dispatchId:         ${dispatchId}`,
        `  status:             running`,
        `  duration:           ${Date.now() - start}ms`,
        '',
        pollHint,
      ].join('\n');
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
