// Contract (input schema, behaviour): SPEC §execution_trace
/**
 * execution_trace — the walk's recent moves, or one call or row, from records
 * (src/tools/_records.ts).
 *
 * With no id: the store's head (`record_read { head: true }`), then the selections
 * written in the last RECENT_WINDOW rows (`{ shape: "selection", after_seq }`), newest
 * first: each move's time, the ask it worked (`root`) and what it chose.
 * With an id: a call by its id (`{ call_id }`: type, state, root, and its output),
 * else a row by its id (`{ ids }`, a selection's candidates summarised).
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { clip, operatorGate, readCalls, readRows, recordRead } from './_records.js';
import { renderMove } from './goal-reasoning.js';

export const ExecutionTraceTool = {
  name: 'execution_trace',
  description:
    "Read the walk's work from records. With no execution_id: its most recent moves, newest first (time, the ask each worked, what it chose). With one: that call (a call_id from goal_reasoning: type, how it ended, the ask it served, and its output), or else the row with that id. Needs the cockpit's own operator sign-in, issued by the USER on the human surface: until then it reads nothing and says so.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      execution_id: {
        type: 'string',
        description: 'A call_id (from goal_reasoning) or a row id to read. Omit it to list the most recent moves.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'With no execution_id: how many recent moves to list (1–50, default 10).',
      },
    },
  },
};

export const InputSchema = z.object({
  execution_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type ExecutionTraceInput = z.infer<typeof InputSchema>;

/** How many of the newest rows the recent-moves list looks in. */
const RECENT_WINDOW = 2_000;
/** A call's output shown, at most. */
const MAX_OUTPUT = 2_000;

async function listRecent(limit: number): Promise<string> {
  const head = await recordRead<{ at_seq?: unknown }>({ head: true });
  if (head.kind !== 'ok') return `execution_trace: ${head.message}`;
  const at = typeof head.body?.at_seq === 'number' ? head.body.at_seq : 0;
  const after = Math.max(0, at - RECENT_WINDOW);
  const sels = await readRows({ shape: 'selection', after_seq: after });
  if (sels.kind !== 'ok') return `execution_trace: ${sels.message}`;
  if (!sels.body.length) return `execution_trace: no moves in the newest ${RECENT_WINDOW} rows (records is at seq ${at}).`;
  const newest = [...sels.body].sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0)).slice(0, limit);
  return [
    `Recent moves, newest first: ${newest.length} of ${sels.body.length} in the newest ${RECENT_WINDOW} rows`,
    ...newest.map((s) => `  ${s.t ?? ''}  ask ${s.root ?? '?'}  chose ${clip(s.a ?? '(not given)', 100)}  (${s.id})`),
    '',
    'How the walk worked one ask: goal_reasoning { "dispatch_id": "<ask>" }; one move: execution_trace { "execution_id": "<id>" }.',
  ].join('\n');
}

export async function handle(input: ExecutionTraceInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const gate = await operatorGate('execution_trace');
  if (gate) return gate;
  if (!input.execution_id) return listRecent(input.limit ?? 10);
  const id = input.execution_id;

  const calls = await readCalls({ call_id: id });
  if (calls.kind !== 'ok') return `execution_trace: ${calls.message}`;
  const call = calls.body[0];
  if (call) {
    return [
      `Call ${call.call_id}`,
      `  type:   ${call.type ?? '?'}`,
      `  state:  ${call.state ?? '?'}${call.t ? `   at ${call.t}` : ''}`,
      `  ask:    ${call.root ?? '?'} (${call.open === true ? 'open' : call.open === false ? 'closed' : 'not given'})`,
      `  move:   ${call.selection_ref ?? '?'}`,
      `  output: ${call.output === undefined ? '(none)' : clip(call.output, MAX_OUTPUT)}`,
    ].join('\n');
  }

  const rows = await readRows({ ids: [id] });
  if (rows.kind !== 'ok') return `execution_trace: ${rows.message}`;
  const row = rows.body[0];
  if (!row) return `execution_trace: records holds no call or row ${id}`;
  if (row.shape === 'selection') return [`Move ${row.id} on ask ${row.root ?? '?'}`, ...renderMove(row, 1)].join('\n');
  const { id: _id, shape, role, t, ...rest } = row;
  return [`Row ${row.id}`, `  shape: ${shape}`, `  role:  ${role ?? '?'}${t ? `   at ${t}` : ''}`, `  ${clip(rest, MAX_OUTPUT)}`].join('\n');
}
