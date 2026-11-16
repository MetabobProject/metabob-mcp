// Contract (input schema, behaviour): SPEC §goal_status
/**
 * goal_status — an ask's state as records gives it, by the dispatchId run_goal /
 * run_goal_async returned (the ask row's id).
 *
 * Composed from records reads through the attachment (src/tools/_records.ts@root-status):
 * the ask row (`{ ids }`), the rows citing it (`{ refs_to }`: answers and the deadline
 * row), the outcomes on each with records' `standing`, and whether records lists it
 * among the open roots (its calls' `open`, else the walker's `{ episode, roots: "all" }`).
 * Reached and failed are named only from grades records counted; the deadline's `at`
 * is shown as stored, with no lapse drawn from it here.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { operatorGate, rootStatus } from './_records.js';

export const GoalStatusTool = {
  name: 'goal_status',
  description:
    "Read the state of an ask made with run_goal or run_goal_async, as records gives it: open or closed, each answer the walk gave with the grades on it (and whether records counted them), and the deadline as stored. Closed reached means a person's counted r 1 on an answer; closed failed means a counted lapse of its deadline. Read gently: a few reads, then minutes apart, since an ask closes only by a person's grade or its deadline. Needs the cockpit's own operator sign-in, issued by the USER on the human surface: until then it reads nothing and says so.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      dispatch_id: {
        type: 'string',
        description: 'The dispatchId returned by run_goal or run_goal_async (the ask row id).',
      },
    },
    required: ['dispatch_id'],
  },
};

export const InputSchema = z.object({
  dispatch_id: z.string().min(1, 'dispatch_id is required'),
});

export type GoalStatusInput = z.infer<typeof InputSchema>;

export async function handle(input: GoalStatusInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const gate = await operatorGate('goal_status');
  if (gate) return gate;
  const status = await rootStatus(input.dispatch_id);
  if (status.kind !== 'ok') return `goal_status: ${status.message}`;
  return [
    `Ask ${input.dispatch_id}`,
    ...status.body.lines,
    '',
    `The walk's moves and calls: goal_reasoning { "dispatch_id": "${input.dispatch_id}" }`,
  ].join('\n');
}
