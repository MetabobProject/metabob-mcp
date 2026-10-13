import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { cleanupTempStores, makeTempStore } from '../helpers/temp-store';
import { deliverResolution, reconcileUndelivered } from '../../src/agent-delivery';
import { LocalStore, type AgentResolutionRecord } from '../../src/local-store';
import { setResolverIdentity } from '../../src/resolver-identity';
import * as PullAssignedWork from '../../src/tools/pull-assigned-work';
import * as SubmitResolution from '../../src/tools/submit-resolution';

const realFetch = globalThis.fetch;
const prevGoalHost = process.env.GOAL_HOST_VESSEL_URL;

beforeEach(() => {
  process.env.GOAL_HOST_VESSEL_URL = 'http://goal-host.test';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevGoalHost === undefined) delete process.env.GOAL_HOST_VESSEL_URL;
  else process.env.GOAL_HOST_VESSEL_URL = prevGoalHost;
  cleanupTempStores();
});

function freshStore(): LocalStore {
  return makeTempStore('mcp-deliv-').store;
}

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

const apiClient = { getDiscoveryEndpoint: () => undefined } as any;

function res(over: Partial<AgentResolutionRecord> = {}): AgentResolutionRecord {
  return {
    task_id: 'sid-1', vessel_id: 'v1', outcome: 'answered', answer: 'use B',
    delivered: 0, attempts: 0, last_attempt_at: null, last_error: null, created_at: Date.now(),
    ...over,
  };
}

describe('deliverResolution', () => {
  test('200 resolved:true → ok', async () => {
    stubFetch(200, { resolved: true, shape: 'solicitationResponse_write' });
    expect(await deliverResolution(apiClient, res())).toEqual({ ok: true });
  });
  test('404 → terminal (solicitation gone)', async () => {
    stubFetch(404, { resolved: false, error: 'no pending solicitation with that id' });
    const out = await deliverResolution(apiClient, res());
    expect(out.ok).toBe(false);
    expect(out.terminal).toBe(true);
  });
  test('resolved:false → retryable failure', async () => {
    stubFetch(200, { resolved: false, error: 'bad' });
    const out = await deliverResolution(apiClient, res());
    expect(out.ok).toBe(false);
    expect(out.terminal).toBeUndefined();
  });
  test('network error → retryable failure', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const out = await deliverResolution(apiClient, res());
    expect(out.ok).toBe(false);
    expect(out.error).toContain('ECONNREFUSED');
  });
});

describe('reconcileUndelivered', () => {
  test('delivers ok, abandons 404, bumps transient', async () => {
    const store = freshStore();
    store.recordResolution(res({ task_id: 'ok-1', vessel_id: 'v1' }));
    store.recordResolution(res({ task_id: 'gone-1', vessel_id: 'v1' }));

    // ok-1 succeeds, gone-1 404s
    globalThis.fetch = (async (_url: any, init: any) => {
      const sid = JSON.parse(init.body).impulse.pointer.solicitationId;
      return sid === 'ok-1'
        ? new Response(JSON.stringify({ resolved: true }), { status: 200 })
        : new Response(JSON.stringify({ resolved: false, error: 'gone' }), { status: 404 });
    }) as typeof fetch;

    const r = await reconcileUndelivered(apiClient, store, 'v1');
    expect(r.delivered).toBe(1);
    expect(r.abandoned).toBe(1);
    expect(store.getUndeliveredResolutions('v1').length).toBe(0); // both cleared
  });
});

describe('submit_resolution tool', () => {
  test('records then delivers; marks delivered on success', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v1', operatorId: 'op' });
    store.enqueueAgentTask({
      task_id: 'sid-1', vessel_id: 'v1', operator_id: 'op', session_id: 's', shape: 'human_input',
      dispatch_id: null, question_markdown: '## Q', respond_via_json: '{}',
      deadline_ms: Date.now() + 300_000, status: 'pending', enqueued_at: Date.now(), claimed_at: null,
    });
    stubFetch(200, { resolved: true });

    const out = await SubmitResolution.handle(
      { task_id: 'sid-1', outcome: 'answered', answer: 'B' }, apiClient, 's', store,
    );
    expect(out).toContain('delivered');
    expect(store.getUndeliveredResolutions('v1').length).toBe(0);
  });

  test('keeps the answer for retry when delivery fails', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v1', operatorId: 'op' });
    store.enqueueAgentTask({
      task_id: 'sid-2', vessel_id: 'v1', operator_id: 'op', session_id: 's', shape: 'human_input',
      dispatch_id: null, question_markdown: '## Q', respond_via_json: '{}',
      deadline_ms: Date.now() + 300_000, status: 'pending', enqueued_at: Date.now(), claimed_at: null,
    });
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch;

    const out = await SubmitResolution.handle(
      { task_id: 'sid-2', outcome: 'answered', answer: 'B' }, apiClient, 's', store,
    );
    expect(out).toContain('retried');
    const undelivered = store.getUndeliveredResolutions('v1');
    expect(undelivered.length).toBe(1);
    expect(undelivered[0]!.attempts).toBe(1);
  });

  test('unknown task_id is reported', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v1', operatorId: 'op' });
    const out = await SubmitResolution.handle(
      { task_id: 'nope', outcome: 'declined' }, apiClient, 's', store,
    );
    expect(out).toContain('No assigned task');
  });
});

describe('pull_assigned_work tool', () => {
  test('claims pending tasks and formats them', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v1', operatorId: 'op' });
    store.enqueueAgentTask({
      task_id: 'sid-9', vessel_id: 'v1', operator_id: 'op', session_id: 's', shape: 'human_input',
      dispatch_id: 'd1', question_markdown: '## Decide', respond_via_json: '{}',
      deadline_ms: Date.now() + 300_000, status: 'pending', enqueued_at: Date.now(), claimed_at: null,
    });
    const out = await PullAssignedWork.handle({}, apiClient, 'sess-1', store);
    expect(out).toContain('sid-9');
    expect(out).toContain('## Decide');
    expect(store.getAgentTask('v1', 'sid-9')?.status).toBe('claimed');
  });

  test('reports when there is no work', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v-empty', operatorId: 'op' });
    const out = await PullAssignedWork.handle({}, apiClient, 'sess-1', store);
    expect(out).toContain('No assigned work');
  });

  test('an empty queue says nothing can arrive, and names no opt-in', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v-optin', operatorId: 'op' });
    const out = await PullAssignedWork.handle({}, apiClient, 'sess-1', store);
    expect(out).toBe(PullAssignedWork.NO_INBOUND_OFFER);
    expect(out).toContain('none can arrive');
    expect(out).not.toContain('METABOB_AGENT_RESOLVER');
  });

  test('a task already in the local queue is listed', async () => {
    const store = freshStore();
    setResolverIdentity({ vesselId: 'v-off', operatorId: 'op' });
    store.enqueueAgentTask({
      task_id: 'sid-off', vessel_id: 'v-off', operator_id: 'op', session_id: 's', shape: 'human_input',
      dispatch_id: null, question_markdown: 'Pick one', respond_via_json: '{}',
      deadline_ms: Date.now() + 300_000, status: 'pending', enqueued_at: Date.now(), claimed_at: null,
    });
    const out = await PullAssignedWork.handle({}, apiClient, 'sess-1', store);
    expect(out).toContain('sid-off');
  });
});
