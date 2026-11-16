/**
 * The goal tools over records (src/tools/_records.ts): an ask is a `world_changed`
 * row written under a key identity marks `operator`; status, reasoning and traces are
 * `record_read`s; feedback is an operator's `outcome` row that closes nothing. Under
 * any other key nothing is read or written. The rows the stub answers are records'
 * own forms (tests/fixtures/records-rows.json: installed records' read answers, with
 * ids, writers and text redacted), adjusted only where a test needs another value.
 * SPEC §substrate-goal-tools
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OWNER_RECHECK_MS, setAttachment } from '../../src/attachment';
import { handle as runGoal } from '../../src/tools/run-goal';
import { handle as runGoalAsync } from '../../src/tools/run-goal-async';
import { handle as goalStatus } from '../../src/tools/goal-status';
import { handle as goalReasoning } from '../../src/tools/goal-reasoning';
import { handle as provideFeedback } from '../../src/tools/provide-feedback';
import { handle as executionTrace } from '../../src/tools/execution-trace';
import { WAITING_ON_SIGN_IN } from '../../src/tools/_records';
import { installShapeStub, type ShapeHandler } from '../helpers/shape-stub';
import type { AnalysisAPIClient } from '../../src/api-client';

const apiClient = {} as AnalysisAPIClient;
const F = JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/records-rows.json'), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

const ASK = clone(F['1_record_read_shape_world_changed_ids'][0]);
const ASK_ID: string = ASK.id;
const CITING: any[] = F['2_record_read_refs_to_ask__one_of_each_shape'];
const ANSWER = clone(CITING.find((r) => r.shape === 'answer'));
const DUE = clone(CITING.find((r) => r.shape === 'due'));
const WALK_ROW = clone(CITING.find((r) => r.role === 'walk'));
const COUNTED_OUTCOME = clone(F['3_record_read_refs_to_answer__outcomes'].counted[0]);
const SELECTION = clone(F['4_record_read_selection_where_root'][0]);
const FAILURE = clone(F['5_failure_with_blames'][0]);
const CALLS: any[] = F['6a_record_read_root_calls_all_output_false__first2'];
const ONE_CALL = clone(F['6b_record_read_call_id'][0]);
const EPISODE = clone(F['7_record_read_episode_roots_all__cut']);
const ARM = clone(F['8_owner_arm_row'][0]);

const WALKER = 'walk-fixture';
WALK_ROW.writer = WALKER;

/** An outcome of the real form, as `role` grading `judged` at `r`, with records' standing. */
function outcome(judged: string, r: number, role: string, standing?: { counted: boolean; why?: string }) {
  const o = clone(COUNTED_OUTCOME);
  o.input_refs = [judged];
  o.r = r;
  o.role = role;
  if (standing) o.standing = standing;
  else delete o.standing;
  return o;
}

/** records' read answers for one ask, by the query forms the tools send. */
function records(opts: {
  citing?: any[];
  outcomes?: Record<string, any[]>;
  calls?: any[];
  episodeRoots?: any[];
  selections?: any[];
  failures?: any[];
  write?: (row: any) => { status?: number; body: unknown };
} = {}): Record<string, ShapeHandler> {
  return {
    record_read: (p) => {
      if (p.head === true) return { body: { at_seq: 5000 } };
      if (p.root && p.calls === 'all') return { body: opts.calls ?? [] };
      if (p.call_id) return { body: p.call_id === ONE_CALL.call_id ? [ONE_CALL] : [] };
      if (p.episode) return { body: { ...EPISODE, roots: opts.episodeRoots ?? EPISODE.roots } };
      if (p.ids) return { body: p.ids.includes(ASK_ID) ? [ASK] : p.ids.includes(SELECTION.id) ? [SELECTION] : [] };
      if (p.refs_to && p.shape === 'outcome') return { body: opts.outcomes?.[p.refs_to] ?? [] };
      if (p.refs_to) return { body: p.refs_to === ASK_ID ? opts.citing ?? [ANSWER, DUE, WALK_ROW] : [] };
      if (p.shape === 'selection') return { body: opts.selections ?? [SELECTION] };
      if (p.shape === 'failure') return { body: opts.failures ?? [] };
      if (p.shape === 'arm') return { body: [ARM] };
      return { body: [] };
    },
    record_write: (p) => (opts.write ? opts.write(p.row) : { body: { ...clone(ASK), ...p.row, role: 'operator' } }),
  };
}

afterEach(() => setAttachment(null));

describe('the operator gate: nothing is read or written under a key identity does not mark operator', () => {
  const calls = [
    () => runGoalAsync({ goal: 'make the change' }, apiClient),
    () => runGoal({ goal: 'make the change' }, apiClient),
    () => goalStatus({ dispatch_id: ASK_ID }, apiClient),
    () => goalReasoning({ dispatch_id: ASK_ID }, apiClient),
    () => provideFeedback({ dispatch_id: ASK_ID, verdict: 'reached', rationale: 'it works' }, apiClient),
    () => executionTrace({}, apiClient),
  ];
  for (const [label, ownerKind] of [['the shared key (no class given)', undefined], ["a person's key", 'person']] as const) {
    test(`${label}: every goal tool waits on the cockpit's own sign-in and sends nothing`, async () => {
      const stub = await installShapeStub(records(), ownerKind ? { ownerKind } : {});
      for (const call of calls) {
        const out = await call();
        expect(out).toContain(WAITING_ON_SIGN_IN);
      }
      expect(stub.pointers).toEqual([]);
    });
  }

  test('a key identity marks later counts without a restart: the org check runs again once the last one is old', async () => {
    let kind: string | undefined;
    const stub = await installShapeStub(records(), { ownerKind: () => kind, ownerRecheckMs: 0 });
    expect(await runGoalAsync({ goal: 'x' }, apiClient)).toContain(WAITING_ON_SIGN_IN);
    kind = 'operator';
    expect(await runGoalAsync({ goal: 'x' }, apiClient)).toContain('Ask recorded.');
    expect(stub.calls('record_write')).toHaveLength(1);
  });

  test('by default the mark is re-checked at most every 15 min, and the reply says so', async () => {
    let kind: string | undefined;
    let checks = 0;
    const stub = await installShapeStub(records(), { ownerKind: () => (checks++, kind) });
    const first = await runGoalAsync({ goal: 'x' }, apiClient);
    expect(first).toContain('re-checked at most every 15 min');
    const after = checks;
    kind = 'operator';
    // Within 15 min of the last check no org check runs: the earlier answer stands and nothing is sent.
    expect(await runGoalAsync({ goal: 'x' }, apiClient)).toContain(WAITING_ON_SIGN_IN);
    expect(checks).toBe(after);
    expect(OWNER_RECHECK_MS).toBe(15 * 60_000);
    expect(stub.pointers).toEqual([]);
  });
});

describe('run_goal_async / run_goal', () => {
  test('writes the goal as a world_changed row and hands back its row id as the dispatchId', async () => {
    const stub = await installShapeStub(records(), { ownerKind: 'operator' });
    const out = await runGoalAsync({ goal: 'make the change' }, apiClient);
    expect(stub.calls('record_write')).toEqual([{ type: 'record_write', row: { shape: 'world_changed', what: 'make the change' } }]);
    expect(out).toContain(`dispatchId: ${ASK_ID}`);
    expect(out).toContain('role:       operator');
    expect(out).not.toContain('⚠');
  });

  test('a row records stamped as anything but an operator\'s is said to be no ask', async () => {
    await installShapeStub(records({ write: (row) => ({ body: { ...clone(ASK), ...row, role: 'unmarked' } }) }), { ownerKind: 'operator' });
    expect(await runGoalAsync({ goal: 'x' }, apiClient)).toContain('records stamped this row unmarked, not operator');
  });

  test("records' cross-node refusal of an operator's row says to attach to the walk's node", async () => {
    await installShapeStub(records({
      write: () => ({ status: 403, body: { failure: { status: 403, body: "a cross-node write needs a key identity marks as a person's or another node's" } } }),
    }), { ownerKind: 'operator' });
    expect(await runGoalAsync({ goal: 'x' }, apiClient)).toContain("this cockpit is attached to a node that doesn't hold the walk's records; attach to the walk's node");
  });

  test('run_goal reads the rows citing the ask until an answer appears, then gives its state', async () => {
    let reads = 0;
    const handlers = records({ calls: CALLS.map((c) => ({ ...c, open: true })) });
    const read = handlers.record_read!;
    handlers.record_read = (p) => {
      if (p.refs_to === ASK_ID && !p.shape) return { body: ++reads < 2 ? [DUE] : [ANSWER, DUE] };
      return read(p);
    };
    const saved = process.env.RUN_GOAL_POLL_MS;
    process.env.RUN_GOAL_POLL_MS = '1';
    try {
      await installShapeStub(handlers, { ownerKind: 'operator' });
      const out = await runGoal({ goal: 'make the change' }, apiClient);
      expect(out).toContain('Ask recorded and answered.');
      expect(out).toContain('state:    open');
      expect(out).toContain(`answer ${ANSWER.id}`);
    } finally {
      if (saved === undefined) delete process.env.RUN_GOAL_POLL_MS;
      else process.env.RUN_GOAL_POLL_MS = saved;
    }
  });
});

describe('goal_status', () => {
  test('an open ask: its answers with their grades and standing, and the deadline as stored, with no lapse drawn from it', async () => {
    const stub = await installShapeStub(records({
      calls: CALLS.map((c) => ({ ...c, open: true })),
      outcomes: { [ANSWER.id]: [outcome(ANSWER.id, 1, 'operator', { counted: false, why: 'not_a_grader' })] },
    }), { ownerKind: 'operator' });
    const out = await goalStatus({ dispatch_id: ASK_ID }, apiClient);
    expect(out).toContain('state:    open');
    expect(out).toContain(`due:      ${new Date(DUE.at).toISOString()} (as stored)`);
    expect(out).not.toMatch(/lapsed|failed/);
    expect(out).toContain('r 1 by operator — not counted (not_a_grader)');
    expect(stub.calls('record_read')).toContainEqual({ type: 'record_read', ids: [ASK_ID] });
    expect(stub.calls('record_read')).toContainEqual({ type: 'record_read', refs_to: ASK_ID });
    expect(stub.calls('record_read')).toContainEqual({ type: 'record_read', root: ASK_ID, calls: 'all', output: false });
  });

  test("closed by a person's counted r 1 on an answer: reached", async () => {
    await installShapeStub(records({
      calls: CALLS,
      outcomes: { [ANSWER.id]: [outcome(ANSWER.id, 1, 'person', { counted: true })] },
    }), { ownerKind: 'operator' });
    expect(await goalStatus({ dispatch_id: ASK_ID }, apiClient)).toContain(`state:    closed: reached (a person's counted r 1 on answer ${ANSWER.id})`);
  });

  test("an operator's r 1 alone does not read as reached, even once records lists the ask closed", async () => {
    await installShapeStub(records({
      calls: CALLS,
      outcomes: { [ANSWER.id]: [outcome(ANSWER.id, 1, 'operator', { counted: false, why: 'not_a_grader' })] },
    }), { ownerKind: 'operator' });
    const out = await goalStatus({ dispatch_id: ASK_ID }, apiClient);
    expect(out).not.toContain('reached');
    expect(out).toContain('state:    closed (records lists it among no open roots)');
  });

  test('closed by a counted lapse on its deadline row: failed', async () => {
    await installShapeStub(records({
      calls: CALLS,
      outcomes: { [DUE.id]: [outcome(DUE.id, 0, 'described', { counted: true })] },
    }), { ownerKind: 'operator' });
    expect(await goalStatus({ dispatch_id: ASK_ID }, apiClient)).toContain(`state:    closed: failed (a counted lapse on its deadline ${DUE.id})`);
  });

  test('a grade records gives no standing for is said so, never read as counted', async () => {
    await installShapeStub(records({
      calls: CALLS,
      outcomes: { [ANSWER.id]: [outcome(ANSWER.id, 1, 'person')] },
    }), { ownerKind: 'operator' });
    const out = await goalStatus({ dispatch_id: ASK_ID }, apiClient);
    expect(out).toContain('r 1 by person — standing not given by records');
    expect(out).not.toContain('reached');
  });

  test("the deadline row's lapsed field is shown as records gives it", async () => {
    const due = { ...clone(DUE), lapsed: { at: DUE.at, standing: { counted: true } } };
    await installShapeStub(records({ citing: [ANSWER, due, WALK_ROW], calls: CALLS }), { ownerKind: 'operator' });
    expect(await goalStatus({ dispatch_id: ASK_ID }, apiClient)).toContain(`lapsed {"at":${DUE.at},"standing":{"counted":true}}`);
  });

  test("with no calls yet, openness is read from the walker's episode: the walk row citing the ask names it", async () => {
    const root = { ...EPISODE.roots[0], root: { ...EPISODE.roots[0].root, id: ASK_ID } };
    const stub = await installShapeStub(records({ calls: [], episodeRoots: [root] }), { ownerKind: 'operator' });
    expect(await goalStatus({ dispatch_id: ASK_ID }, apiClient)).toContain('state:    open');
    expect(stub.calls('record_read')).toContainEqual({ type: 'record_read', episode: WALKER, roots: 'all' });
  });

  test('a row records does not hold is said so', async () => {
    await installShapeStub(records(), { ownerKind: 'operator' });
    expect(await goalStatus({ dispatch_id: 'f'.repeat(64) }, apiClient)).toBe(`goal_status: records holds no row ${'f'.repeat(64)}`);
  });
});

describe('goal_reasoning', () => {
  test('each move with what it chose from and the posteriors drawn, the failures on those moves with their blame, and the calls', async () => {
    const failure = { ...clone(FAILURE), selection_ref: SELECTION.id };
    const other = { ...clone(FAILURE), id: 'e'.repeat(64), selection_ref: 'not-this-ask' };
    const stub = await installShapeStub(records({ calls: CALLS, failures: [failure, other] }), { ownerKind: 'operator' });
    const out = await goalReasoning({ dispatch_id: ASK_ID }, apiClient);
    expect(out).toContain(`chose ${SELECTION.a}`);
    expect(out).toContain(`from ${SELECTION.cands.length} candidates`);
    const p0 = SELECTION.posts[0];
    expect(out).toContain(`${SELECTION.cands[0].id}  α ${Math.round(p0.alpha * 100) / 100} β ${Math.round(p0.beta * 100) / 100} (${p0.from})`);
    expect(out).toContain('Failures: 1');
    expect(out).toContain('blames walk');
    expect(out).toContain('Calls: 2');
    expect(out).toContain(`answer ended  call_id ${CALLS[0].call_id}`);
    expect(stub.calls('record_read')).toContainEqual({ type: 'record_read', shape: 'selection', where: { root: ASK_ID } });
  });
});

describe('provide_feedback', () => {
  test("writes an operator's outcome on the one answer, and says it is no verdict", async () => {
    const stub = await installShapeStub(records({
      write: (row) => ({ body: { ...clone(COUNTED_OUTCOME), ...row, id: 'd'.repeat(64), role: 'operator' } }),
    }), { ownerKind: 'operator' });
    const out = await provideFeedback({ dispatch_id: ASK_ID, verdict: 'reached', rationale: 'the diff does it' }, apiClient);
    expect(stub.calls('record_write')).toEqual([{ type: 'record_write', row: { shape: 'outcome', r: 1, why: 'the diff does it', input_refs: [ANSWER.id] } }]);
    expect(out).toContain(`Recorded as an operator's note on ${ANSWER.id}. It is not a verdict: it closes nothing and moves no posterior. A verdict that counts is a person's, on the surface.`);
  });

  test('with several answers and none named, it writes nothing and lists them', async () => {
    const second = { ...clone(ANSWER), id: 'c'.repeat(64) };
    const stub = await installShapeStub(records({ citing: [ANSWER, second, DUE] }), { ownerKind: 'operator' });
    const out = await provideFeedback({ dispatch_id: ASK_ID, verdict: 'partial', rationale: 'r' }, apiClient);
    expect(out).toContain('has 2 answers; name one with answer_id');
    expect(stub.calls('record_write')).toEqual([]);
  });
});

describe('execution_trace', () => {
  test('a call by its id, with its output', async () => {
    await installShapeStub(records(), { ownerKind: 'operator' });
    const out = await executionTrace({ execution_id: ONE_CALL.call_id }, apiClient);
    expect(out).toContain(`Call ${ONE_CALL.call_id}`);
    expect(out).toContain('state:  ended');
    expect(out).toContain(`ask:    ${ASK_ID} (closed)`);
    expect(out).toContain('"shape":"answer"');
  });

  test('with no id: the newest moves in the last rows', async () => {
    const stub = await installShapeStub(records(), { ownerKind: 'operator' });
    const out = await executionTrace({}, apiClient);
    expect(out).toContain(`ask ${ASK_ID}  chose ${SELECTION.a}`);
    expect(stub.calls('record_read')).toContainEqual({ type: 'record_read', shape: 'selection', after_seq: 3000 });
  });
});
