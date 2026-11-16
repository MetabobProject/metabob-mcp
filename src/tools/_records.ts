/**
 * records-vessel, reached through the attachment — discovery `POST /resolve`, which
 * forwards to records' resolver (CONFORMANCE §c11-attachment-model). Shared by
 * run_goal, run_goal_async, goal_status, goal_reasoning, provide_feedback and
 * execution_trace (SPEC §substrate-goal-tools).
 *
 * The cockpit's goal loop is records' rows: an ask is a `world_changed` row written
 * under a key identity marks `operator` (records stamps the role from that mark, never
 * from the writer), the walk works it as a root, and its answers, deadline, grades,
 * selections and calls are rows that cite it. Every read and write here waits on that
 * operator sign-in: under any other key nothing is sent (src/tools/_records.ts@operator-gate).
 *
 * Pointer contracts, from records-vessel src/index.ts and src/store.ts:
 *   - `record_write { row }` answers the stored row `{ id, seq, t, writer, role, … }`, or
 *     `{ failure: { status, body } }` with that status (a cross-node refusal is 403).
 *   - `record_read { ids | refs_to | shape | where | after_seq }` answers the matching rows;
 *     `{ root, calls: "all", output: false }` and `{ call_id }` answer calls
 *     `{ call_id, type, selection_ref, root, open, state, seq, t, output? }`;
 *     `{ episode, roots: "all" }` answers `{ shared, roots: [{ root, rows, awaits }] }`;
 *     `{ head: true }` answers `{ at_seq }`.
 */

import { OWNER_RECHECK_MS, RESOLVE_TIMEOUT_MS, attachedOwnerKind, describeResolveFailure, resolveShape, substrateRefusal } from '../attachment.js';

/** The class identity gives the key records takes the cockpit's asks and reads from. */
export const OPERATOR = 'operator';

export const WAITING_ON_SIGN_IN = "waiting on the cockpit's own sign-in, issued by the USER on the human surface";

/** A records read or write answers within concept-db's family cap. */
const RECORDS_TIMEOUT_MS = RESOLVE_TIMEOUT_MS.concept;

export type Row = { id: string; shape: string; seq?: number; t?: string; writer?: string; role?: string; input_refs?: unknown; [k: string]: unknown };

export interface Call {
  call_id: string;
  type?: string;
  selection_ref?: string;
  root?: string;
  open?: boolean;
  state?: string;
  seq?: number;
  t?: string;
  output?: unknown;
}

export type Read<T> = { kind: 'ok'; body: T } | { kind: 'error'; message: string };

// @anchor operator-gate
/**
 * Null when the attached key is one identity marks `operator`, else the line the tool answers with. No row is
 * read or written under any other key: the shared key's rows cannot be told from its other holders'.
 */
export async function operatorGate(tool: string): Promise<string | null> {
  const refused = await substrateRefusal();
  if (refused) return `${tool}: ${refused}`;
  const kind = await attachedOwnerKind(OPERATOR);
  if (kind === OPERATOR) return null;
  return `${tool}: ${WAITING_ON_SIGN_IN}. Identity marks this server's key ${kind ? `as ${kind}` : 'as nothing'}, not operator, so nothing was sent to records; the mark is re-checked at most every ${OWNER_RECHECK_MS / 60_000} min.`;
}

/** The failure records answered, as one line. */
function failureLine(shape: string, status: number, body: unknown): string {
  const f = (body as { failure?: { status?: unknown; body?: unknown } } | undefined)?.failure;
  const said = f && typeof f.body === 'string' && f.body ? f.body : JSON.stringify(body ?? null).slice(0, 200);
  return `${shape} answered ${status}: ${said}`;
}

/** One records read: retried when it is cut at its timeout. */
export async function recordRead<T = Row[]>(query: Record<string, unknown>): Promise<Read<T>> {
  let res;
  try {
    res = await resolveShape({ type: 'record_read', ...query }, { timeoutMs: RECORDS_TIMEOUT_MS, read: true });
  } catch (err) {
    return { kind: 'error', message: describeResolveFailure(err) };
  }
  if (res.status !== 200 || (res.body && typeof res.body === 'object' && 'failure' in res.body)) {
    return { kind: 'error', message: failureLine('record_read', res.status, res.body) };
  }
  return { kind: 'ok', body: res.body as T };
}

/** Rows read as a list; anything else is records answering a form this server does not read. */
export async function readRows(query: Record<string, unknown>): Promise<Read<Row[]>> {
  const r = await recordRead<unknown>(query);
  if (r.kind !== 'ok') return r;
  if (!Array.isArray(r.body)) return { kind: 'error', message: `record_read answered no list: ${JSON.stringify(r.body).slice(0, 200)}` };
  return { kind: 'ok', body: r.body.filter((x): x is Row => !!x && typeof x === 'object' && typeof (x as Row).id === 'string') };
}

/** Calls read as a list (`{ root, calls }` and `{ call_id }`). */
export async function readCalls(query: Record<string, unknown>): Promise<Read<Call[]>> {
  const r = await recordRead<unknown>(query);
  if (r.kind !== 'ok') return r;
  if (!Array.isArray(r.body)) return { kind: 'error', message: `record_read answered no list: ${JSON.stringify(r.body).slice(0, 200)}` };
  return { kind: 'ok', body: r.body.filter((x): x is Call => !!x && typeof x === 'object' && typeof (x as Call).call_id === 'string') };
}

export type Written = { kind: 'ok'; row: Row } | { kind: 'error'; message: string };

/** One records write: never retried, since a second write is a second row. */
export async function recordWrite(row: Record<string, unknown>): Promise<Written> {
  let res;
  try {
    res = await resolveShape({ type: 'record_write', row }, { timeoutMs: RECORDS_TIMEOUT_MS });
  } catch (err) {
    return { kind: 'error', message: describeResolveFailure(err) };
  }
  const body = res.body as Row | { failure?: { body?: unknown } } | undefined;
  if (res.status === 200 && body && typeof (body as Row).id === 'string') return { kind: 'ok', row: body as Row };
  const said = String((body as { failure?: { body?: unknown } } | undefined)?.failure?.body ?? '');
  // The cockpit writes only world_changed and outcome rows, under an operator's key: records refuses those with 403 only
  // when they were forwarded from another node (crossNode), so the status says it; records' reason is quoted as given.
  if (res.status === 403) {
    return {
      kind: 'error',
      message: `this cockpit is attached to a node that doesn't hold the walk's records; attach to the walk's node (records: ${said})`,
    };
  }
  return { kind: 'error', message: failureLine('record_write', res.status, res.body) };
}

export const refsOf = (r: Row): string[] => [r.input_refs].flat().filter((x) => x !== undefined && x !== null).map(String);

/** A deadline row: one records gave an `at` from the `within_ms` it states. Told by its fields, not its shape name. */
export const isDue = (r: Row): boolean => r.role === 'described' && typeof r.within_ms === 'number' && typeof r.at === 'number';

export const isAnswer = (r: Row): boolean => r.shape === 'answer';

/** A grade's standing as records gives it: counted, not counted and why, or not given. */
export function standingText(r: Row): string {
  const s = r.standing as { counted?: unknown; why?: unknown } | undefined;
  if (!s || typeof s !== 'object') return 'standing not given by records';
  if (s.counted === true) return 'counted';
  return `not counted${typeof s.why === 'string' && s.why ? ` (${s.why})` : ''}`;
}

/** Whether records counted a grade or a lapse: its `standing` (`{ counted, why? }`) says so. */
const counted = (r: Row | { standing?: unknown } | undefined): boolean => (r?.standing as { counted?: unknown } | undefined)?.counted === true;

const iso = (ms: unknown): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));

/** One line of text, at most `max` characters. */
export function clip(v: unknown, max = 160): string {
  const s = (typeof v === 'string' ? v : JSON.stringify(v ?? null)).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The walker that works a root: a walk row citing it says, else the newest owner arm row. */
async function walkerOf(citing: Row[]): Promise<Read<string | null>> {
  const own = citing.filter((r) => r.role === 'walk' && typeof r.writer === 'string').at(-1);
  if (own) return { kind: 'ok', body: String(own.writer) };
  const arms = await readRows({ shape: 'arm', where: { role: 'owner' } });
  if (arms.kind !== 'ok') return arms;
  const arm = arms.body.at(-1);
  return { kind: 'ok', body: arm && typeof arm.vessel_id === 'string' ? arm.vessel_id : null };
}

/** Whether records lists the root among the open roots: from its calls when it has any, else from the walker's episode read. */
async function openness(id: string, citing: Row[]): Promise<Read<boolean | null>> {
  const calls = await readCalls({ root: id, calls: 'all', output: false });
  if (calls.kind !== 'ok') return calls;
  const first = calls.body.find((c) => typeof c.open === 'boolean');
  if (first) return { kind: 'ok', body: first.open! };
  const walker = await walkerOf(citing);
  if (walker.kind !== 'ok') return walker;
  if (!walker.body) return { kind: 'ok', body: null };
  const ep = await recordRead<{ roots?: Array<{ root?: Row }> }>({ episode: walker.body, roots: 'all' });
  if (ep.kind !== 'ok') return ep;
  if (!Array.isArray(ep.body?.roots)) return { kind: 'error', message: 'record_read { episode, roots: "all" } answered no roots list' };
  return { kind: 'ok', body: ep.body.roots.some((x) => x?.root?.id === id) };
}

// @anchor root-status
/**
 * A root's state as records gives it, in lines: the ask, open or closed (from records' list of open roots), each
 * answer with the grades on it and their standing, and the deadline row with its `at` as stored. A verdict is named
 * only from a grade records counted: reached by a person's counted r 1 on an answer, failed by a counted r 0 on the
 * deadline row, or by the lapse records derives on the deadline row itself (`lapsed: { at, standing }`, standing in the
 * outcome's form, with no outcome row). The cockpit draws no lapse of its own from `at`: the `lapsed` field is shown as records gives it.
 * SPEC §goal_status
 */
export async function rootStatus(id: string): Promise<Read<{ lines: string[]; answers: Row[]; open: boolean | null }>> {
  const asked = await readRows({ ids: [id] });
  if (asked.kind !== 'ok') return asked;
  const root = asked.body[0];
  if (!root) return { kind: 'error', message: `records holds no row ${id}` };
  const citing = await readRows({ refs_to: id });
  if (citing.kind !== 'ok') return citing;
  const answers = citing.body.filter(isAnswer);
  const due = citing.body.find(isDue);
  const graded = new Map<string, Row[]>();
  for (const judged of [...answers, ...(due ? [due] : [])]) {
    const r = await readRows({ refs_to: judged.id, shape: 'outcome' });
    if (r.kind !== 'ok') return r;
    graded.set(judged.id, r.body);
  }
  const open = await openness(id, citing.body);
  if (open.kind !== 'ok') return open;

  const reachedOn = answers.find((a) => (graded.get(a.id) ?? []).some((g) => g.role === 'person' && g.r === 1 && counted(g)));
  const lapse = due !== undefined
    && ((graded.get(due.id) ?? []).some((g) => g.r === 0 && counted(g)) || counted(due.lapsed as { standing?: unknown } | undefined));
  const state = open.body === null ? 'not known (no walker has worked it, and no walk is armed)'
    : open.body ? 'open'
    : reachedOn ? `closed: reached (a person's counted r 1 on answer ${reachedOn.id})`
    : lapse ? `closed: failed (a counted lapse on its deadline ${due!.id})`
    : 'closed (records lists it among no open roots)';

  const lines = [
    `  ask:      ${clip(root.what ?? root.summary ?? root.shape)}`,
    `  role:     ${root.role ?? '(not given)'}${root.t ? `   at ${root.t}` : ''}`,
    `  state:    ${state}`,
  ];
  if (due) {
    lines.push(`  due:      ${iso(due.at)} (as stored)${due.lapsed !== undefined ? `; lapsed ${clip(due.lapsed)}` : ''}`);
    for (const g of graded.get(due.id) ?? []) lines.push(`            r ${g.r} by ${g.role} — ${standingText(g)}`);
  } else {
    lines.push('  due:      no deadline row cites it yet');
  }
  if (answers.length === 0) lines.push('  answers:  none yet');
  for (const a of answers) {
    lines.push(`  answer ${a.id}${a.t ? ` (${a.t})` : ''}: ${clip(a.text ?? a.what ?? '')}`);
    const gs = graded.get(a.id) ?? [];
    if (gs.length === 0) lines.push('            no grade yet');
    for (const g of gs) lines.push(`            r ${g.r} by ${g.role} — ${standingText(g)}`);
  }
  return { kind: 'ok', body: { lines, answers, open: open.body } };
}
