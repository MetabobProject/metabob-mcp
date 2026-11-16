/**
 * W1 — the operator loop over records (SPEC §substrate-goal-tools), through the
 * server's stdio and the fake substrate's discovery: ask, read the state, read the
 * moves and calls, leave a note. The walk's rows are installed records' own read answers
 * (tests/fixtures/records-rows.json, through harness/records-walk.ts).
 *
 *   - Under a key identity does not mark `operator` (the shared key), every goal
 *     tool answers that it waits on the cockpit's own sign-in, and no records
 *     shape reaches discovery.
 *   - Under an operator's key, the ask is a `world_changed` row records stamps
 *     `operator`; its answer and grades read back; the note is an `outcome` row
 *     whose reply says it is not a verdict.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { FakeSubstrate } from './harness/fake-substrate';
import { seedWalk } from './harness/records-walk';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

// Each server boot is a process spawn; slow CI runners need more than the 5 s default.
setDefaultTimeout(30_000);
const BOOT_TIMEOUT_MS = 30_000;

const WAITING = "waiting on the cockpit's own sign-in, issued by the USER on the human surface";

let fake: FakeSubstrate;
let server: McpServer;

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  cleanupTempDirs();
}, BOOT_TIMEOUT_MS);

describe('W1 operator loop: the shared key', () => {
  beforeAll(async () => {
    fake = await FakeSubstrate.start();
    server = await McpServer.start({ workspace: makeWorkspace('operator-shared-ws'), env: fake.env() });
  }, BOOT_TIMEOUT_MS);
  afterAll(async () => {
    await server?.stop();
    await fake?.stop();
  }, BOOT_TIMEOUT_MS);

  test('every goal tool waits on the cockpit\'s own sign-in, and no records shape is sent', async () => {
    for (const [tool, args] of [
      ['run_goal_async', { goal: 'make the change' }],
      ['goal_status', { dispatch_id: 'row_x' }],
      ['goal_reasoning', { dispatch_id: 'row_x' }],
      ['provide_feedback', { dispatch_id: 'row_x', verdict: 'reached', rationale: 'r' }],
      ['execution_trace', {}],
    ] as const) {
      expect(await server.text(tool, args)).toContain(WAITING);
    }
    expect(fake.requests.filter((r) => r.service === 'records')).toEqual([]);
  });
});

describe("W1 operator loop: an operator's key", () => {
  beforeAll(async () => {
    fake = await FakeSubstrate.start();
    fake.ownerKind = 'operator';
    server = await McpServer.start({ workspace: makeWorkspace('operator-ws'), env: fake.env() });
  }, BOOT_TIMEOUT_MS);
  beforeEach(() => fake.resetState());

  test('ask → its state, answer and deadline → moves and calls → an operator\'s note that is no verdict', async () => {
    const asked = await server.text('run_goal_async', { goal: 'edit repos/x/src/a.ts: rename foo' });
    const id = /dispatchId:\s*(\S+)/.exec(asked)?.[1];
    expect(id, asked).toBeDefined();
    const ask = fake.state.rows.find((r) => r.id === id)!;
    expect(ask).toMatchObject({ shape: 'world_changed', what: 'edit repos/x/src/a.ts: rename foo', role: 'operator' });

    // The walk's rows on it, from installed records' own read answers.
    const walk = seedWalk(fake.state, id!);

    const status = await server.text('goal_status', { dispatch_id: id! });
    // The walk's counted r 0 on its deadline row: records' lapse, read as records gives it.
    expect(status).toContain(`state:    closed: failed (a counted lapse on its deadline ${walk.due.id})`);
    expect(status).toContain(`due:      ${new Date(Number(walk.due.at)).toISOString()} (as stored)`);
    expect(status).toContain(`answer ${walk.answer.id}`);

    const reasoning = await server.text('goal_reasoning', { dispatch_id: id! });
    expect(reasoning).toContain(`chose ${walk.selection.a}`);
    expect(reasoning).toContain(`from ${(walk.selection.cands as unknown[]).length} candidates`);
    for (const c of walk.calls) expect(reasoning).toContain(`${c.type} ${c.state}  call_id ${c.call_id}`);

    const call = await server.text('execution_trace', { execution_id: String(walk.readCall.call_id) });
    expect(call).toContain(`ask:    ${id} (closed)`);
    expect(call).toContain(`"id":"${(walk.readCall.output as { id: string }).id}"`);
    expect(await server.text('execution_trace', {})).toContain(`ask ${id}  chose ${walk.selection.a}`);

    const note = await server.text('provide_feedback', { dispatch_id: id!, verdict: 'reached', rationale: 'diff does what was asked' });
    expect(note).toContain('It is not a verdict: it closes nothing and moves no posterior.');
    expect(fake.state.rows.at(-1)).toMatchObject({ shape: 'outcome', r: 1, why: 'diff does what was asked', input_refs: [walk.answer.id], role: 'operator' });
  });

  test('records is reached only through discovery /resolve', () => {
    const hops = fake.requests.filter((r) => r.service === 'records');
    expect(hops.length).toBeGreaterThan(0);
    expect(hops.filter((r) => !r.forwarded)).toEqual([]);
  });
});
