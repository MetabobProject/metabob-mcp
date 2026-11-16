// Contract (input schema, behaviour): SPEC §run_goal_async
/**
 * run_goal_async — ask the walk for something WITHOUT waiting.
 *
 * Writes the ask as a records `world_changed` row (`record_write`, through the
 * attachment; src/tools/_records.ts) under the cockpit's operator sign-in. records
 * stamps the role from identity's mark: an operator's ask is a root the walk works.
 * The stored row's id is the dispatch id; goal_status reads the root's state by it.
 * Under any key identity does not mark `operator` nothing is written
 * (src/tools/_records.ts@operator-gate). CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { OPERATOR, operatorGate, recordWrite, type Row } from './_records.js';

export const RunGoalAsyncTool = {
  name: 'run_goal_async',
  description:
    "Ask the substrate's walk for something, without waiting: writes the goal as an operator's ask (a records world_changed row) and returns its row id as the dispatchId at once; read its state with goal_status. The walk takes the ask as a root and works it; a person's grade of an answer on the human surface closes it, or its deadline lapsing does, which counts as failed unless the walk is waiting on a person: each ask costs the USER a grade. Needs the cockpit's own operator sign-in, issued by the USER on the human surface: until then it writes nothing and says so.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description:
          "What you want done, in plain words. It runs on the substrate, not in this workspace: a code change names its file as repos/<vessel>/src/<path> in the substrate's repositories, which need not exist locally.",
      },
    },
    required: ['goal'],
  },
};

export const InputSchema = z.object({
  goal: z.string().min(1, 'goal is required'),
});

export type RunGoalAsyncInput = z.infer<typeof InputSchema>;

/** Write the ask: the stored row, or the line the tool answers with. */
export async function writeAsk(tool: string, goal: string): Promise<{ kind: 'ok'; row: Row } | { kind: 'error'; line: string }> {
  const gate = await operatorGate(tool);
  if (gate) return { kind: 'error', line: gate };
  const w = await recordWrite({ shape: 'world_changed', what: goal });
  if (w.kind !== 'ok') return { kind: 'error', line: `${tool}: ${w.message}` };
  return { kind: 'ok', row: w.row };
}

// @anchor ask-cost
/**
 * What every ask costs the USER: only a person's grade closes it, and an ungraded deadline counts as failed, except while
 * the walk waits on a person (records holds that lapse, and a later person's grade overtakes it).
 */
export const ASK_COST =
  "  cost:       each ask costs the USER a grade on the human surface; left ungraded, its deadline lapses and counts as failed against the walk's moves on it, unless the walk is waiting on a person";

/** The line saying the row is not an ask, when records stamped it as anything but an operator's. */
export function roleWarning(row: Row): string | null {
  return row.role === OPERATOR
    ? null
    : `  ⚠ records stamped this row ${row.role ?? '(no role)'}, not operator: it is stored, but the walk does not take it as an ask`;
}

export async function handle(
  input: RunGoalAsyncInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const w = await writeAsk('run_goal_async', input.goal);
  if (w.kind !== 'ok') return w.line;
  return [
    'Ask recorded.',
    `  dispatchId: ${w.row.id}`,
    `  role:       ${w.row.role ?? '(not given)'}`,
    roleWarning(w.row),
    ASK_COST,
    '',
    `Read its state with: goal_status { "dispatch_id": "${w.row.id}" }`,
  ].filter((l) => l !== null).join('\n');
}
