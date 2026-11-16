// Contract (input schema, behaviour): SPEC §run_goal
/**
 * run_goal — ask the walk for something and wait a while for its first answer.
 *
 * Writes the ask as run_goal_async does (src/tools/run-goal-async.ts@writeAsk),
 * then reads the rows that cite it (`record_read { refs_to }`) with short pauses
 * until an answer row appears or the polling deadline passes
 * (`RUN_GOAL_TIMEOUT_MS`, default 290 s), and answers with the root's state as
 * goal_status gives it (src/tools/_records.ts@root-status). An ask closes only by
 * a person's grade or its deadline lapsing, so the reply usually shows it open:
 * it keeps being worked, and its dispatchId reads on with goal_status.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { isAnswer, readRows, rootStatus } from './_records.js';
import { roleWarning, writeAsk } from './run-goal-async.js';

// @anchor run-goal-deadline
/** The polling deadline: how long run_goal waits for an answer before handing back the dispatchId. */
export function runGoalDeadlineMs(): number {
  return parseInt(process.env.RUN_GOAL_TIMEOUT_MS || '290000', 10);
}

/** The pause before the first reads. */
export function runGoalPollMs(): number {
  return parseInt(process.env.RUN_GOAL_POLL_MS || '2000', 10);
}

/** The longest pause between two reads. */
export function runGoalPollMaxMs(): number {
  return parseInt(process.env.RUN_GOAL_POLL_MAX_MS || '15000', 10);
}

/**
 * The pause before read `n` (0-based): the base pause for the first three reads,
 * then doubling up to the ceiling, so a long walk is read gently rather than
 * every few seconds for its whole life.
 */
export function runGoalPollDelayMs(n: number, baseMs = runGoalPollMs(), maxMs = runGoalPollMaxMs()): number {
  if (n < 3) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** (n - 2));
}

export const RunGoalTool = {
  name: 'run_goal',
  description:
    "Ask the substrate's walk for something and wait up to ~290s for its first answer: writes the goal as an operator's ask (a records world_changed row), then reads the rows that cite it until an answer appears, and returns the ask's state as goal_status gives it. An ask closes only when a person grades an answer on the human surface or its deadline lapses, so it usually comes back open with an answer to read; keep reading it with goal_status. Needs the cockpit's own operator sign-in, issued by the USER on the human surface: until then it writes nothing and says so. Prefer run_goal_async when you do not need to wait.",
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

export type RunGoalInput = z.infer<typeof InputSchema>;

export async function handle(
  input: RunGoalInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();
  const deadline = start + runGoalDeadlineMs();
  const w = await writeAsk('run_goal', input.goal);
  if (w.kind !== 'ok') return w.line;
  const id = w.row.id;
  const pollHint = `Read on with: goal_status { "dispatch_id": "${id}" }`;
  const warning = roleWarning(w.row);
  if (warning) return ['Ask recorded, not waited on.', `  dispatchId: ${id}`, warning].join('\n');

  // @anchor run-goal-poll
  let answered = false;
  for (let poll = 0; ; poll++) {
    const pollMs = runGoalPollDelayMs(poll);
    const citing = await readRows({ refs_to: id });
    if (citing.kind !== 'ok') {
      return [`run_goal: recorded ${id}, then could not read the rows citing it: ${citing.message}`, pollHint].join('\n');
    }
    if (citing.body.some(isAnswer)) {
      answered = true;
      break;
    }
    if (Date.now() + pollMs >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const status = await rootStatus(id);
  return [
    answered
      ? 'Ask recorded and answered.'
      : `Ask recorded, with no answer by the ${runGoalDeadlineMs()}ms deadline (RUN_GOAL_TIMEOUT_MS); the walk keeps working it.`,
    `  dispatchId: ${id}`,
    ...(status.kind === 'ok' ? status.body.lines : [`  state:    could not be read: ${status.message}`]),
    `  duration:   ${Date.now() - start}ms`,
    '',
    pollHint,
  ].join('\n');
}
