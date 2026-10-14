/**
 * W1 — the operator loop (SPEC §substrate-goal-tools): dispatch, poll until
 * done, read `reached` rather than `status`, read the reasoning, then label.
 *
 * Three outcomes, because `status` alone mis-judges two of them:
 *   - reached     — status completed, reached true;
 *   - hollow      — status completed, reached false: must never read as success;
 *   - satisfier   — status failed, reached true, no durable trace: must read as reached.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

// Each server boot is a process spawn; slow CI runners need more than the 5 s default.
setDefaultTimeout(30_000);
const BOOT_TIMEOUT_MS = 30_000;

let fake: FakeSubstrate;
let server: McpServer;

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  server = await McpServer.start({ workspace: makeWorkspace('operator-ws'), env: fake.env() });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  cleanupTempDirs();
}, BOOT_TIMEOUT_MS);

beforeEach(() => fake.resetState());

/** The verdict line `goal_status` / `goal_reasoning` print first, under the header. */
function verdictLine(text: string): string {
  return text.split('\n')[1] ?? '';
}

async function dispatch(goal: string): Promise<string> {
  const out = await server.text('run_goal_async', { goal });
  const id = /dispatchId:\s*(\S+)/.exec(out)?.[1];
  expect(id, out).toBeDefined();
  return id!;
}

/** Poll as an operator does: until the dispatch is no longer running. */
async function pollUntilDone(dispatchId: string): Promise<string[]> {
  const polls: string[] = [];
  for (let i = 0; i < 10; i++) {
    const out = await server.text('goal_status', { dispatch_id: dispatchId });
    polls.push(out);
    if (!/^\s*status:\s+running\b/m.test(out)) return polls;
  }
  throw new Error(`dispatch ${dispatchId} still running after 10 polls:\n${polls.at(-1)}`);
}

const RUNNING = { status: 'running', reached: null, walkLog: ['[goal-host-vessel] selecting template for goal'] };

describe('W1 operator loop', () => {
  test('reached: dispatch → poll → reached:yes → reasoning → label', async () => {
    fake.state.nextDispatches.push({
      frames: [
        RUNNING,
        {
          status: 'completed', reached: true, executionId: 'exec-reached', selectedTemplateId: 'tmpl-feature-compose',
          walkLog: ['[goal-host-vessel] selected feature_compose', '[goal-host-vessel] typecheck passed'],
        },
      ],
    });
    fake.state.traces.set('exec-reached', {
      id: 'exec-reached', status: 'completed',
      tags: ['state_signature:abc123', 'reached:true', 'completion_shapes:code_change'],
      output_impulse_shapes: ['code_change'],
      tasks: [{ resolver_id: 'development-vessel', resolver_tier: 'llm', input_shapes: ['goal'], output_shapes: ['code_change'], success: true }],
      selection: { alpha: 4, beta: 1 },
    });

    const id = await dispatch('edit repos/x/src/a.ts: rename foo');
    expect(fake.requestsFor('goalDispatchAsync')[0]?.body).toMatchObject({ goal: 'edit repos/x/src/a.ts: rename foo', operator: expect.any(String) });

    const polls = await pollUntilDone(id);
    expect(polls.length).toBe(2);
    expect(verdictLine(polls[0]!)).toContain('(running)');
    expect(polls[0]).toContain('selecting template');
    const done = polls.at(-1)!;
    expect(verdictLine(done)).toMatch(/reached:\s+yes/);
    expect(done).toContain('state_signature:abc123');

    const reasoning = await server.text('goal_reasoning', { dispatch_id: id });
    expect(verdictLine(reasoning)).toMatch(/reached:\s+yes/);
    expect(reasoning).toContain('1. selected feature_compose');
    expect(reasoning).toMatch(/#1 ✓ development-vessel \/llm\s+goal → code_change/);

    const fb = await server.text('provide_feedback', { dispatch_id: id, verdict: 'reached', rationale: 'diff does what was asked' });
    expect(fb).toContain('Feedback recorded');
    expect(fake.state.labels).toHaveLength(1);
    expect(fake.state.labels[0]).toMatchObject({
      type: 'goal_verification_label_write', verdict: 'achieved', execution_id: 'exec-reached',
      activity_id: 'tmpl-feature-compose', goal: 'edit repos/x/src/a.ts: rename foo', labeler: 'human',
    });
  });

  test('hollow: status completed + reached false never renders as success', async () => {
    fake.state.nextDispatches.push({
      frames: [{ status: 'completed', reached: false, executionId: 'exec-hollow', selectedTemplateId: 'tmpl-noop' }],
    });
    fake.state.traces.set('exec-hollow', {
      id: 'exec-hollow', status: 'completed', tags: ['reached:false'],
      tasks: [{ resolver_id: 'noop-vessel', input_shapes: ['goal'], output_shapes: ['memoryNote'], success: true }],
    });

    const id = await dispatch('make the build green');
    const [status] = await pollUntilDone(id);
    expect(verdictLine(status!)).toMatch(/reached:\s+no$/);
    expect(status).not.toMatch(/reached:\s+yes/);
    // The verdict line comes before, and is labelled apart from, the exit status.
    expect(status!.indexOf('reached:')).toBeLessThan(status!.indexOf('status:'));
    expect(status).toContain('status below is only the template exit status');

    const reasoning = await server.text('goal_reasoning', { dispatch_id: id });
    expect(verdictLine(reasoning)).toMatch(/reached:\s+no$/);
    expect(reasoning).not.toMatch(/reached:\s+yes/);

    const fb = await server.text('provide_feedback', { dispatch_id: id, verdict: 'not_reached', rationale: 'template ran but changed nothing' });
    expect(fb).toContain('Feedback recorded');
    expect(fake.state.labels[0]).toMatchObject({ verdict: 'not_achieved', execution_id: 'exec-hollow' });
  });

  test('satisfier: status failed + reached true reads as reached, with no durable trace', async () => {
    fake.state.nextDispatches.push({
      frames: [{
        status: 'failed', reached: true, executionId: 'exec-satisfier', selectedTemplateId: 'satisfier:conceptGraph',
        error: 'template exit non-zero', walkLog: ['[goal-host-vessel] satisfier conceptGraph produced the goal shape'],
      }],
    });
    // No trace for a satisfier reach: activity-api answers 404.

    const id = await dispatch('find the auth design note');
    const [status] = await pollUntilDone(id);
    expect(verdictLine(status!)).toMatch(/reached:\s+yes/);
    expect(status).toMatch(/status:\s+failed/);
    expect(status).toContain('trace hydration unavailable');

    const reasoning = await server.text('goal_reasoning', { dispatch_id: id });
    expect(verdictLine(reasoning)).toMatch(/reached:\s+yes/);
    expect(reasoning).toContain('1. satisfier conceptGraph produced the goal shape');
    const traceReads = fake.requestsFor('executionTrace').filter(r => (r.body as any)?.executionId === 'exec-satisfier');
    expect(traceReads.length).toBeGreaterThan(0);
    expect(traceReads.every(r => r.status === 404)).toBe(true);

    const fb = await server.text('provide_feedback', { dispatch_id: id, verdict: 'reached', rationale: 'satisfier answered the goal' });
    expect(fb).toContain('Feedback recorded');
    expect(fake.state.labels[0]).toMatchObject({ verdict: 'achieved', activity_id: 'satisfier:conceptGraph' });
  });

  test('goal-host and activity-api are reached only through discovery /resolve', () => {
    const producerHops = fake.requests.filter(r => r.service === 'goalHost' || r.service === 'activity');
    expect(producerHops.length).toBeGreaterThan(0);
    expect(producerHops.filter(r => !r.forwarded)).toEqual([]);
    expect(fake.requests.filter(r => r.operation === null)).toEqual([]);
  });
});
