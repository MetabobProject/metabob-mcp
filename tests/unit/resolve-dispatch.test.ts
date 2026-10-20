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
  test('posts {pointer} to discovery /resolve and answers the producer status and body', async () => {
    const stub = await installShapeStub({ goalWalkState: () => ({ status: 404, body: { resolved: false, error: 'dispatch not found' } }) });
    const res = await resolveShape({ type: 'goalWalkState', dispatchId: 'd1' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ resolved: false, error: 'dispatch not found' });
    expect(stub.calls('goalWalkState')).toEqual([{ type: 'goalWalkState', dispatchId: 'd1' }]);
    expect(stub.urls.filter((u) => u.endsWith('/resolve') && !u.includes('/auth/'))).toEqual([`${STUB_DISCOVERY}/resolve`]);
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
      feature_compose: () => ({ status: 502, body: { error: 'forward_failed', shape: 'feature_compose', detail: 'The operation timed out.' } }),
    });
    expect(await resolveImpulse({ shape: 'feature_compose' }, apiClient)).toMatch(/^resolve_impulse: producer_timeout\(feature_compose, \d+ms\)/);
    expect(stub.calls('feature_compose')).toHaveLength(1);
  });
  // An agent reads the system's leases; it never takes or releases them. SPEC §resolve_impulse
  test('refuses the substrate\'s own lease writes before any request, by shape or by pointer.type', async () => {
    const stub = await installShapeStub({
      maintenanceLease_write: () => ({ body: { acquired: true } }),
      substrateGapLease_write: () => ({ body: { granted: true } }),
      memoryNote: () => ({ body: { success: true } }),
    });
    const lease = await resolveImpulse({ shape: 'maintenanceLease_write', pointer: { op: 'acquire', name: 'autonomous_pick', holder: 'x' } }, apiClient);
    expect(lease).toStartWith('resolve_impulse: refused: maintenanceLease_write is the substrate\'s own coordination');
    expect(lease).toContain('record a finding with its holder, name and expiry');
    const gap = await resolveImpulse({ shape: 'substrateGapLease_write', pointer: { action: 'acquire', gap_id: 'g', holder: 'x' } }, apiClient);
    expect(gap).toStartWith('resolve_impulse: refused: substrateGapLease_write');
    // pointer.type overrides shape, so the refusal reads the effective type.
    const smuggled = await resolveImpulse({ shape: 'memoryNote', pointer: { type: 'maintenanceLease_write', op: 'release', token: 't' } }, apiClient);
    expect(smuggled).toStartWith('resolve_impulse: refused: maintenanceLease_write');
    expect(stub.calls('maintenanceLease_write')).toHaveLength(0);
    expect(stub.calls('substrateGapLease_write')).toHaveLength(0);
    expect(stub.calls('memoryNote')).toHaveLength(0);
  });

  test('refuses every write an agent does not make, by shape and by pointer.type', async () => {
    const { COORDINATION_WRITES } = await import('../../src/tools/resolve-impulse');
    const shapes = Object.keys(COORDINATION_WRITES);
    expect(shapes).toEqual(expect.arrayContaining([
      'activityExecutionTrace_write', 'execution_write', 'goal_verification_label_write', 'poolImpulse_write',
      'substrateGap_write', 'pushPolicy_write', 'llmModelPolicy_write', 'docFixPolicy_write', 'renderPolicy_write',
    ]));
    const stub = await installShapeStub(Object.fromEntries([...shapes, 'memoryNote'].map((s) => [s, () => ({ body: { ok: true } })])));
    for (const shape of shapes) {
      expect(await resolveImpulse({ shape, pointer: {} }, apiClient)).toStartWith(`resolve_impulse: refused: ${shape} `);
      expect(await resolveImpulse({ shape: 'memoryNote', pointer: { type: shape } }, apiClient)).toStartWith(`resolve_impulse: refused: ${shape} `);
      expect(stub.calls(shape)).toHaveLength(0);
    }
    expect(stub.calls('memoryNote')).toHaveLength(0);
    // A self-graded trace is the case this exists for.
    const graded = await resolveImpulse({ shape: 'activityExecutionTrace_write', pointer: { traceData: { tags: ['reached:true'] } } }, apiClient);
    expect(graded).toContain('an agent never writes a trace');
  });

  test('a shape named like an Object.prototype member is passed through, not refused', async () => {
    const stub = await installShapeStub({ constructor: () => ({ body: { ok: true } }) });
    expect(await resolveImpulse({ shape: 'constructor' }, apiClient)).toStartWith('resolve_impulse constructor → discovery /resolve');
    expect(stub.calls('constructor')).toHaveLength(1);
  });

  test('the lease reads pass through', async () => {
    const stub = await installShapeStub({ maintenanceLease: () => ({ body: { held: false } }) });
    expect(await resolveImpulse({ shape: 'maintenanceLease' }, apiClient)).toStartWith('resolve_impulse maintenanceLease → discovery /resolve [200]');
    expect(stub.calls('maintenanceLease')).toHaveLength(1);
  });
});
