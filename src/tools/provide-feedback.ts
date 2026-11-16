// Contract (input schema, behaviour): SPEC §provide_feedback
/**
 * provide_feedback — an operator's note on an answer the walk gave to an ask.
 *
 * Finds the ask's answers (`record_read { refs_to }`, src/tools/_records.ts) and writes
 * one `outcome` row `{ r, why, input_refs: [answer] }` under the cockpit's operator
 * sign-in. records keeps it as a row, but an operator's grade closes nothing and moves
 * no posterior: only a person's grade on the human surface counts as a verdict. The
 * reply says so.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { clip, isAnswer, operatorGate, readRows, recordWrite } from './_records.js';

export const ProvideFeedbackTool = {
  name: 'provide_feedback',
  description:
    "Leave an operator's note on an answer the walk gave to an ask made with run_goal or run_goal_async: reached (r 1), not_reached (r 0) or partial (r 0.5), with your rationale. It is kept as a row, but it is not a verdict: it closes nothing and moves no posterior. A verdict that counts is a person's, on the human surface. With more than one answer, name the one with answer_id (goal_status lists them). Needs the cockpit's own operator sign-in, issued by the USER on the human surface: until then it writes nothing and says so.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      dispatch_id: {
        type: 'string',
        description: 'The dispatchId returned by run_goal or run_goal_async (the ask row id).',
      },
      verdict: {
        type: 'string',
        enum: ['reached', 'not_reached', 'partial'],
        description: 'Whether the answer did what was asked.',
      },
      rationale: {
        type: 'string',
        description: 'Why: the evidence behind the note. Stored on the row as `why`.',
      },
      answer_id: {
        type: 'string',
        description: 'The answer row to note, when the ask has more than one (goal_status lists them).',
      },
    },
    required: ['dispatch_id', 'verdict', 'rationale'],
  },
};

export const InputSchema = z.object({
  dispatch_id: z.string().min(1, 'dispatch_id is required'),
  verdict: z.enum(['reached', 'not_reached', 'partial']),
  rationale: z.string().min(1, 'rationale is required'),
  answer_id: z.string().min(1).optional(),
});

export type ProvideFeedbackInput = z.infer<typeof InputSchema>;

const R: Record<ProvideFeedbackInput['verdict'], number> = { reached: 1, not_reached: 0, partial: 0.5 };

export async function handle(input: ProvideFeedbackInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const gate = await operatorGate('provide_feedback');
  if (gate) return gate;

  const citing = await readRows({ refs_to: input.dispatch_id });
  if (citing.kind !== 'ok') return `provide_feedback: ${citing.message}`;
  const answers = citing.body.filter(isAnswer);
  let answer = input.answer_id ? answers.find((a) => a.id === input.answer_id) : answers.length === 1 ? answers[0] : undefined;
  if (input.answer_id && !answer) {
    return `provide_feedback: ${input.answer_id} is not an answer to ${input.dispatch_id}; its answers: ${answers.map((a) => a.id).join(', ') || 'none yet'}`;
  }
  if (!answer) {
    if (answers.length === 0) return `provide_feedback: ${input.dispatch_id} has no answer yet; nothing was written.`;
    return [
      `provide_feedback: ${input.dispatch_id} has ${answers.length} answers; name one with answer_id. Nothing was written.`,
      ...answers.map((a) => `  ${a.id}${a.t ? ` (${a.t})` : ''}: ${clip(a.text ?? '')}`),
    ].join('\n');
  }

  const w = await recordWrite({ shape: 'outcome', r: R[input.verdict], why: input.rationale, input_refs: [answer.id] });
  if (w.kind !== 'ok') return `provide_feedback: ${w.message}`;
  return [
    `Recorded as an operator's note on ${answer.id}. It is not a verdict: it closes nothing and moves no posterior. A verdict that counts is a person's, on the surface.`,
    `  row:   ${w.row.id}`,
    `  r:     ${R[input.verdict]} (${input.verdict})`,
    `  role:  ${w.row.role ?? '(not given)'}`,
  ].join('\n');
}
