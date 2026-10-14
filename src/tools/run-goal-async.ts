// Contract (input schema, behaviour): SPEC §run_goal_async
/**
 * run_goal_async — dispatch a goal to goal-host-vessel WITHOUT blocking.
 *
 * Resolves the `goalDispatchAsync` shape through the attachment (discovery
 * `POST /resolve`; src/tools/_goal-host.ts), which goal-host answers at once
 * with `202 { dispatchId, status }`. The goal then runs in the background; the
 * caller polls `goal_status` with the returned dispatchId. CONFORMANCE
 * §c11-attachment-model
 *
 * The dispatch carries `operator: <MB_OPERATOR_ID>`, which goal-host stamps
 * into the trace's `operator:` tag.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { describeResolveFailure } from '../attachment.js';
import { operatorId } from '../operator-id.js';
import { dispatchFailure, dispatchGoal } from './_goal-host.js';

export const RunGoalAsyncTool = {
  name: 'run_goal_async',
  description:
    "Dispatch a goal to goal-host-vessel asynchronously (shape goalDispatchAsync). Returns a dispatchId immediately without waiting for the goal to finish — the goal runs in the background and you poll it with goal_status. Prefer this over run_goal for long-running goals (composition walks, drafter fallback, recovery) that would outlast run_goal's polling deadline (~290s). Provide either goal (natural-language) or target_template_id (skip Thompson selection). Optional variables seed the execution pool; parent_execution_id + composition_chain thread cross-vessel provenance.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description:
          'Natural-language goal description. Either this or target_template_id is required.',
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

export type RunGoalAsyncInput = z.infer<typeof InputSchema>;

export async function handle(
  input: RunGoalAsyncInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
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
    return `run_goal_async: ${describeResolveFailure(err)}`;
  }

  if ((answer.status !== 202 && answer.status !== 200) || !answer.dispatchId) {
    return dispatchFailure('run_goal_async', answer);
  }

  return [
    'Goal dispatched asynchronously.',
    `  dispatchId: ${answer.dispatchId}`,
    `  status:     ${answer.dispatchStatus ?? 'running'}`,
    '',
    `Poll with: goal_status { "dispatch_id": "${answer.dispatchId}" }`,
  ].join('\n');
}
