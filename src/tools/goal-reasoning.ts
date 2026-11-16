// Contract (input schema, behaviour): SPEC §goal_reasoning
/**
 * goal_reasoning — how the walk worked an ask, from records' own rows, by the
 * dispatchId run_goal / run_goal_async returned (the ask row's id).
 *
 * Three records reads through the attachment (src/tools/_records.ts):
 *   1. `{ shape: "selection", where: { root } }` — each move: what it chose (`a`), its
 *      cell, and the candidates it chose from with the posteriors drawn (`cands`
 *      and `posts`, index for index).
 *   2. `{ shape: "failure", after_seq }`, kept to the failures whose `selection_ref` is
 *      one of those moves, with the `blames` records decided.
 *   3. `{ root, calls: "all", output: false }` — the calls in order, each with its
 *      state (started, ended, failed, abandoned), without their outputs; one call's
 *      output reads with execution_trace.
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { clip, operatorGate, readCalls, readRows, type Row } from './_records.js';

export const GoalReasoningTool = {
  name: 'goal_reasoning',
  description:
    "How the walk worked an ask made with run_goal or run_goal_async: each move it made (what it chose, from which candidates, with the posteriors it drew), the failures on those moves and whom records blames for each, and the calls it made in order with how each ended. Read a call's output with execution_trace { execution_id: <call_id> }. Needs the cockpit's own operator sign-in, issued by the USER on the human surface: until then it reads nothing and says so.",
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

export type GoalReasoningInput = z.infer<typeof InputSchema>;

/** Moves shown, newest last; candidates shown per move. */
const MAX_MOVES = 20;
const MAX_CANDS = 8;

const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : '?');

/** One move: what it chose, its cell, and the candidates with the posterior drawn for each. */
export function renderMove(s: Row, n: number): string[] {
  const cands = Array.isArray(s.cands) ? s.cands : [];
  const posts = Array.isArray(s.posts) ? s.posts : [];
  const lines = [`  #${n} ${s.t ?? ''} chose ${clip(s.a ?? '(not given)', 120)}${s.cell ? `  cell ${clip(s.cell, 120)}` : ''}`];
  lines.push(`      from ${cands.length} candidate${cands.length === 1 ? '' : 's'}`);
  cands.slice(0, MAX_CANDS).forEach((c: any, i: number) => {
    const p = posts[i] as { alpha?: unknown; beta?: unknown; from?: unknown } | undefined;
    const drawn = p && typeof p === 'object' ? `  α ${num(p.alpha)} β ${num(p.beta)}${p.from ? ` (${String(p.from)})` : ''}` : '';
    lines.push(`        ${clip(c && typeof c === 'object' ? c.id ?? c.kind : c, 100)}${drawn}`);
  });
  if (cands.length > MAX_CANDS) lines.push(`        … ${cands.length - MAX_CANDS} more`);
  return lines;
}

export async function handle(input: GoalReasoningInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const gate = await operatorGate('goal_reasoning');
  if (gate) return gate;
  const id = input.dispatch_id;

  const sels = await readRows({ shape: 'selection', where: { root: id } });
  if (sels.kind !== 'ok') return `goal_reasoning: ${sels.message}`;
  const moves = [...sels.body].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  const out = [`How the walk worked ask ${id}`, '', `Moves: ${moves.length}`];
  if (moves.length === 0) out.push('  none yet: no walker has made a move on this ask');
  const shown = moves.slice(-MAX_MOVES);
  if (moves.length > shown.length) out.push(`  (the first ${moves.length - shown.length} not shown)`);
  shown.forEach((s, i) => out.push(...renderMove(s, moves.length - shown.length + i + 1)));

  if (moves.length > 0) {
    const ids = new Set(moves.map((s) => s.id));
    const from = Math.min(...moves.map((s) => Number(s.seq ?? 0))) - 1;
    const failures = await readRows({ shape: 'failure', after_seq: Math.max(0, from) });
    if (failures.kind !== 'ok') return `goal_reasoning: ${failures.message}`;
    const mine = failures.body.filter((f) => ids.has(String(f.selection_ref)));
    out.push('', `Failures: ${mine.length}`);
    for (const f of mine) {
      const what = [f.kind, f.refused ? `refused ${f.refused}` : null, typeof f.status === 'number' ? `status ${f.status}` : null].filter(Boolean).join(', ');
      out.push(`  ${f.t ?? ''} ${what || 'failure'}; blames ${f.blames ?? '(not given)'}${f.body ? `: ${clip(f.body, 120)}` : ''}`);
    }
  }

  const calls = await readCalls({ root: id, calls: 'all', output: false });
  if (calls.kind !== 'ok') return [...out, '', `Calls: could not be read: ${calls.message}`].join('\n');
  out.push('', `Calls: ${calls.body.length}`);
  calls.body.forEach((c, i) => out.push(`  #${i + 1} ${c.t ?? ''} ${c.type ?? '?'} ${c.state ?? '?'}  call_id ${c.call_id}`));
  if (calls.body.length) out.push('', 'One call with its output: execution_trace { "execution_id": "<call_id>" }');
  return out.join('\n');
}
