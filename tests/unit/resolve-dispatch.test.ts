/**
 * The one ingress (src/attachment.ts@attachment-resolve): every substrate call
 * is a shape resolved through discovery `POST /resolve`. Discovery's own
 * failures become one named line — no_producer(shape), producer_timeout(shape, ms),
 * producer_unreachable(shape) — a producer's own answer passes through, and only
 * reads cut at the producer's timeout are retried. CONFORMANCE §c11-attachment-model
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  READ_RETRY_DELAYS_MS,
  ResolveError,
  classifyDiscoveryAnswer,
  describeResolveFailure,
  NO_PRODUCER_MEANING,
  resolveShape,
  setAttachment,
} from '../../src/attachment';
import { installShapeStub, STUB_DISCOVERY } from '../helpers/shape-stub';
import { handle as registryQuery } from '../../src/tools/registry-query';
import { handle as resolveImpulse } from '../../src/tools/resolve-impulse';
import type { AnalysisAPIClient } from '../../src/api-client';

const apiClient = {} as AnalysisAPIClient;

afterEach(() => setAttachment(null));

describe('classifyDiscoveryAnswer', () => {
  test('discovery 404 {error:"Not found", shape} is no_producer', () => {
    const err = classifyDiscoveryAnswer('goalWalkState', 404, { error: 'Not found', shape: 'goalWalkState' }, 3);
    expect(err?.kind).toBe('no_producer');
    expect(err?.message).toStartWith('no_producer(goalWalkState)');
    // Through a spoke the same 404 is a peer producer's refusal or missing item;
    // the line keeps the token and says it cannot tell which.
    expect(err?.message).toBe(`no_producer(goalWalkState): ${NO_PRODUCER_MEANING}`);
    expect(NO_PRODUCER_MEANING).toContain('peer forward');
    expect(NO_PRODUCER_MEANING).toContain('refused');
  });

  test("a producer's own 404 passes through", () => {
    expect(classifyDiscoveryAnswer('goalWalkState', 404, { resolved: false, shape: 'goalWalkState', error: 'dispatch not found' }, 3)).toBeNull();
    expect(classifyDiscoveryAnswer('activityExecutionTrace', 404, { success: false, error: 'Execution trace not found: e1' }, 3)).toBeNull();
    expect(classifyDiscoveryAnswer('conceptGraph', 404, { error: 'Concept not found: c1' }, 3)).toBeNull();
  });

  test('a forward cut at the producer timeout is producer_timeout with the elapsed time', () => {
    const err = classifyDiscoveryAnswer('executionTraceList', 502, { error: 'forward_failed', shape: 'executionTraceList', detail: 'The operation timed out.' }, 10_012);
    expect(err?.kind).toBe('producer_timeout');
    expect(err?.message).toStartWith('producer_timeout(executionTraceList, 10012ms)');
  });

  test('any other forward failure is producer_unreachable', () => {
    const err = classifyDiscoveryAnswer('conceptSearch', 502, { error: 'forward_failed', shape: 'conceptSearch', detail: 'Unable to connect' }, 4);
    expect(err?.kind).toBe('producer_unreachable');
    expect(err?.message).toBe('producer_unreachable(conceptSearch): Unable to connect');
  });
});

describe('attachment.resolve()', () => {
  // SPEC §read-only-key: a key whose validated scopes lack write sends no write; reads are untouched.
  test('a read-scoped key sends no write, names why, and still reads', async () => {
    const stub = await installShapeStub({ memoryNote_write: () => ({ body: { ok: true } }), memoryNote: () => ({ body: { ok: true } }) }, { scopes: ['read'] });
    const err = await resolveShape({ type: 'memoryNote_write', note: 'n' }).catch((e) => e);
    expect(String(err.message)).toBe('key_read_only: this key has scopes [read]; the memoryNote_write write was not sent');
    expect(stub.calls('memoryNote_write')).toHaveLength(0);
    expect((await resolveShape({ type: 'memoryNote' }, { read: true })).status).toBe(200);
  });

  test('a write-scoped key writes; with no scopes reported nothing is gated', async () => {
    const rw = await installShapeStub({ memoryNote_write: () => ({ body: { ok: true } }) }, { scopes: ['read', 'write'] });
    await resolveShape({ type: 'memoryNote_write', note: 'n' });
    expect(rw.calls('memoryNote_write')).toHaveLength(1);
    const unknown = await installShapeStub({ memoryNote_write: () => ({ body: { ok: true } }) });
    await resolveShape({ type: 'memoryNote_write', note: 'n' });
    expect(unknown.calls('memoryNote_write')).toHaveLength(1);
  });

  test('posts {pointer} to discovery /resolve and answers the producer status and body', async () => {
    const stub = await installShapeStub({ goalWalkState: () => ({ status: 404, body: { resolved: false, error: 'dispatch not found' } }) });
    const res = await resolveShape({ type: 'goalWalkState', dispatchId: 'd1' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ resolved: false, error: 'dispatch not found' });
    expect(stub.calls('goalWalkState')).toEqual([{ type: 'goalWalkState', dispatchId: 'd1' }]);
    expect(stub.urls.filter((u) => u.endsWith('/resolve') && !u.includes('/auth/'))).toEqual([`${STUB_DISCOVERY}/resolve`]);
  });

  // SPEC §client-claim: a write declares operator, session and client; a read declares nothing.
  test('by default a write carries client_claim, a read none, and a pointer\'s own claim is kept; METABOB_CLIENT_CLAIM=off turns it off', async () => {
    const { sessionId } = await import('../../src/operator-id');
    const stub = await installShapeStub({ memoryNote_write: () => ({ body: { ok: true } }), memoryNote: () => ({ body: { ok: true } }) });
    // METABOB_CLIENT_CLAIM=off: no claim on a write.
    process.env.METABOB_CLIENT_CLAIM = 'off';
    await resolveShape({ type: 'memoryNote_write', note: 'off' });
    expect(stub.claims('memoryNote_write')).toEqual([undefined]);
    stub.pointers.length = 0;
    delete process.env.METABOB_CLIENT_CLAIM;
    try {
      await resolveShape({ type: 'memoryNote_write', note: 'n' });
      await resolveShape({ type: 'memoryNote' }, { read: true });
      await resolveShape({ type: 'memoryNote_write', note: 'm', client_claim: { operator: 'x', session: 's', client: 'c' } });
    } finally {
      delete process.env.METABOB_CLIENT_CLAIM;
    }
    const [first, kept] = stub.claims('memoryNote_write');
    expect(first).toEqual({ operator: expect.any(String), session: sessionId(), client: expect.stringMatching(/^metabob-mcp\/\d/) });
    expect(kept).toEqual({ operator: 'x', session: 's', client: 'c' });
    expect(stub.claims('memoryNote')).toEqual([undefined]);
  });

  test('an unknown shape throws no_producer, named in one line', async () => {
    await installShapeStub({});
    const err = await resolveShape({ type: 'nothingServesThis' }).catch((e) => e);
    expect(err).toBeInstanceOf(ResolveError);
    expect(describeResolveFailure(err)).toBe(`no_producer(nothingServesThis): ${NO_PRODUCER_MEANING}`);
  });

  test('a read cut at the producer timeout is retried with bounded backoff, then named', async () => {
    const stub = await installShapeStub({
      executionTraceList: () => ({ status: 502, body: { error: 'forward_failed', shape: 'executionTraceList', detail: 'The operation timed out.' } }),
    });
    const err = await resolveShape({ type: 'executionTraceList', limit: 1 }, { read: true }).catch((e) => e);
    expect((err as ResolveError).kind).toBe('producer_timeout');
    expect(stub.calls('executionTraceList')).toHaveLength(1 + READ_RETRY_DELAYS_MS.length);
  });

  test('a read that answers on retry succeeds', async () => {
    let n = 0;
    await installShapeStub({
      executionTraceList: () => (++n === 1
        ? { status: 502, body: { error: 'forward_failed', shape: 'executionTraceList', detail: 'timed out' } }
        : { body: { success: true, content: '{}' } }),
    });
    const res = await resolveShape({ type: 'executionTraceList' }, { read: true });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  test('a write cut at the producer timeout is never retried', async () => {
    const stub = await installShapeStub({
      goal_verification_label_write: () => ({ status: 502, body: { error: 'forward_failed', shape: 'goal_verification_label_write', detail: 'timed out' } }),
    });
    const err = await resolveShape({ type: 'goal_verification_label_write' }).catch((e) => e);
    expect((err as ResolveError).kind).toBe('producer_timeout');
    expect(stub.calls('goal_verification_label_write')).toHaveLength(1);
  });

  test('no attachment installed refuses as not_configured', async () => {
    const err = await resolveShape({ type: 'conceptSearch' }).catch((e) => e);
    expect(describeResolveFailure(err)).toStartWith('not_configured:');
  });
});

const SCOPE = "(This node's vocabulary. Shapes served by peer nodes resolve through it but are not listed; ask for one by name with mode: \"vessels\".)";

describe('registry_query', () => {
  const registry = {
    vesselRegistry: () => ({
      body: {
        content: {
          vessels: [
            { vesselId: 'goal-host-vessel', shapes: ['goalWalkState', 'goalDispatchAsync'] },
            { vesselId: 'concept-db-local', shapes: ['conceptSearch', 'goalWalkState'] },
          ],
          totalCount: 2,
        },
        metadata: { shape: 'vesselRegistry' },
      },
    }),
  };

  test('shapes: the vocabulary is the union of vesselRegistry shapes, sorted and filtered', async () => {
    const stub = await installShapeStub(registry);
    expect(await registryQuery({ mode: 'shapes' }, apiClient)).toBe(
      ['Advertised shapes (3):', '  conceptSearch', '  goalDispatchAsync', '  goalWalkState', SCOPE].join('\n'),
    );
    expect(await registryQuery({ mode: 'shapes', shape: 'goal' }, apiClient)).toBe(
      ['Advertised shapes matching "goal" (2/3):', '  goalDispatchAsync', '  goalWalkState', SCOPE].join('\n'),
    );
    expect(stub.calls('vesselRegistry')).toEqual([{ type: 'vesselRegistry' }, { type: 'vesselRegistry' }]);
  });

  test('vessels: vesselCapability rows, cross-checked against the vocabulary', async () => {
    const stub = await installShapeStub({
      ...registry,
      vesselCapability: (p) => ({
        body: {
          content: {
            shape: p.shape,
            found: true,
            vessels: [{ vesselId: 'goal-host-vessel', endpoint: 'http://127.0.0.1:8210', public_endpoint: 'http://127.0.0.1:18210', protocol: 'http', resolve_endpoint: 'http://127.0.0.1:8210/resolve' }],
          },
        },
      }),
    });
    const out = await registryQuery({ mode: 'vessels', shape: 'goalWalkState' }, apiClient);
    expect(out).toBe([
      'Vessels serving "goalWalkState" (1):',
      '  goal-host-vessel',
      '      endpoint:         http://127.0.0.1:18210',
      '      protocol:         http',
      '      resolve_endpoint: http://127.0.0.1:8210/resolve',
    ].join('\n'));
    expect(stub.calls('vesselCapability')).toEqual([{ type: 'vesselCapability', shape: 'goalWalkState' }]);

    const stale = await registryQuery({ mode: 'vessels', shape: 'staleShape' }, apiClient);
    expect(stale).toContain("vesselCapability, but this node's vocabulary (vesselRegistry) does not list it. Producers on peer nodes are not in this node's vocabulary");
  });

  test('a discovery failure is one named line', async () => {
    await installShapeStub({});
    expect(await registryQuery({ mode: 'shapes' }, apiClient)).toBe(
      `registry_query: no_producer(vesselRegistry): ${NO_PRODUCER_MEANING}`,
    );
  });
});

describe('resolve_impulse', () => {
  test('passes the pointer through discovery /resolve once and prints the producer answer', async () => {
    const stub = await installShapeStub({
      memoryNote: (p) => ({ status: 201, body: { success: true, content: `note ${p.note_type}` } }),
    });
    const out = await resolveImpulse({ shape: 'memoryNote', pointer: { note_type: 'feedback', limit: 2 } }, apiClient);
    expect(stub.calls('memoryNote')).toEqual([{ type: 'memoryNote', note_type: 'feedback', limit: 2 }]);
    expect(out).toBe([
      'resolve_impulse memoryNote → discovery /resolve [201]',
      JSON.stringify({ success: true, content: 'note feedback' }, null, 2),
    ].join('\n'));
  });

  test('a write cut at its producer timeout is named and not retried', async () => {
    const stub = await installShapeStub({
      memoryNote_write: () => ({ status: 502, body: { error: 'forward_failed', shape: 'memoryNote_write', detail: 'The operation timed out.' } }),
    });
    expect(await resolveImpulse({ shape: 'memoryNote_write', pointer: { note: 'n' } }, apiClient)).toMatch(/^resolve_impulse: producer_timeout\(memoryNote_write, \d+ms\)/);
    expect(stub.calls('memoryNote_write')).toHaveLength(1);
  });
  // The cockpit refuses no shape; each producer decides what a key may do. SPEC §resolve_impulse
  test.each(['maintenanceLease_write', 'activityExecutionTrace_write', 'shell', 'git_push', 'brandNew_write', 'brandNewRead', 'constructor'])(
    '%s is forwarded through discovery, once', async (shape) => {
      const stub = await installShapeStub({ [shape]: () => ({ body: { ok: true } }) });
      expect(await resolveImpulse({ shape, pointer: { a: 1 } }, apiClient)).toStartWith(`resolve_impulse ${shape} → discovery /resolve [200]`);
      expect(stub.calls(shape)).toHaveLength(1);
    });

  test('pointer.type overrides shape', async () => {
    const stub = await installShapeStub({ memoryNote: () => ({ body: { ok: true } }), record_read: () => ({ body: { rows: [] } }) });
    await resolveImpulse({ shape: 'memoryNote', pointer: { type: 'record_read', shape: 'world_changed' } }, apiClient);
    expect(stub.calls('record_read')).toEqual([{ type: 'record_read', shape: 'world_changed' }]);
    expect(stub.calls('memoryNote')).toHaveLength(0);
  });

  // A second record_write is a second request row, which starts a second walk episode.
  test('record_write passes its pointer through and is never retried, on a timeout or a 5xx', async () => {
    const row = { shape: 'world_changed', body: { text: 'please' }, writer: 'x', role: 'node' };
    const ok = await installShapeStub({ record_write: () => ({ status: 201, body: { ok: true, seq: 7 } }) }, { scopes: ['read', 'write'] });
    expect(await resolveImpulse({ shape: 'record_write', pointer: { row } }, apiClient)).toStartWith('resolve_impulse record_write → discovery /resolve [201]');
    expect(ok.calls('record_write')).toEqual([{ type: 'record_write', row }]);

    const cut = await installShapeStub({
      record_write: () => ({ status: 502, body: { error: 'forward_failed', shape: 'record_write', detail: 'The operation timed out.' } }),
    });
    expect(await resolveImpulse({ shape: 'record_write', pointer: { row } }, apiClient)).toMatch(/^resolve_impulse: producer_timeout\(record_write, \d+ms\)/);
    expect(cut.calls('record_write')).toHaveLength(1);

    for (const status of [500, 503]) {
      const failed = await installShapeStub({ record_write: () => ({ status, body: { error: 'boom' } }) });
      await resolveImpulse({ shape: 'record_write', pointer: { row } }, apiClient);
      expect(failed.calls('record_write')).toHaveLength(1);
    }
  });

  test('record_read is a known read: sent as a read with a read-only key', async () => {
    const stub = await installShapeStub({ record_read: () => ({ body: { rows: [] } }) }, { scopes: ['read'] });
    expect(await resolveImpulse({ shape: 'record_read', pointer: { shape: 'world_changed' } }, apiClient)).toStartWith('resolve_impulse record_read → discovery /resolve [200]');
    expect(stub.calls('record_read')).toHaveLength(1);
  });

  test('a shape that is not a known read is not sent with a read-only key', async () => {
    const stub = await installShapeStub({ record_write: () => ({ body: { ok: true } }) }, { scopes: ['read'] });
    expect(await resolveImpulse({ shape: 'record_write', pointer: { row: {} } }, apiClient)).toContain('key_read_only');
    expect(stub.calls('record_write')).toHaveLength(0);
  });

  test('the lease reads pass through', async () => {
    const stub = await installShapeStub({ maintenanceLease: () => ({ body: { held: false } }) });
    expect(await resolveImpulse({ shape: 'maintenanceLease' }, apiClient)).toStartWith('resolve_impulse maintenanceLease → discovery /resolve [200]');
    expect(stub.calls('maintenanceLease')).toHaveLength(1);
  });
});
