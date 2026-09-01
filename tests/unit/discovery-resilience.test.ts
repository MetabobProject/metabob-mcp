import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clearDiscoveryCache, discoverFirstVesselByShape } from '../../src/discovery';
import { handle as registryQueryHandle } from '../../src/tools/registry-query';

const realFetch = globalThis.fetch;
const prevDiscoveryEnv = process.env.DISCOVERY_ENDPOINT;

const DISCOVERY = 'http://disc.test';

beforeEach(() => {
  clearDiscoveryCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (prevDiscoveryEnv === undefined) delete process.env.DISCOVERY_ENDPOINT;
  else process.env.DISCOVERY_ENDPOINT = prevDiscoveryEnv;
  clearDiscoveryCache();
});

function vesselRow(id: string, endpoint: string, extra: Record<string, unknown> = {}) {
  return { vesselId: id, vesselName: id, endpoint, confidence: 1, lastSeen: 'now', ...extra };
}

/**
 * Routes fetches by URL:
 *  - {DISCOVERY}/resolve → the vessels payload (counts calls)
 *  - <vessel base>/health → 200 if the base is in `healthy`, throws otherwise
 */
function routeFetch(options: { vessels: unknown[]; healthy: string[]; calls?: string[] }): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    options.calls?.push(url);
    if (url === `${DISCOVERY}/resolve`) {
      return new Response(
        JSON.stringify({ content: { shape: 'goal_execution', found: true, vessels: options.vessels } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/health')) {
      const base = url.slice(0, -'/health'.length);
      if (options.healthy.includes(base)) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      throw new Error('connect ECONNREFUSED');
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe('discoverFirstVesselByShape health-checked selection', () => {
  test('healthy first row is returned and cached for 60s', async () => {
    const calls: string[] = [];
    routeFetch({
      vessels: [vesselRow('v-alive', 'http://alive.test:9000')],
      healthy: ['http://alive.test:9000'],
      calls,
    });

    const first = await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(first?.vesselId).toBe('v-alive');

    const resolveCalls = () => calls.filter((u) => u === `${DISCOVERY}/resolve`).length;
    expect(resolveCalls()).toBe(1);

    // Cached: a second call must not hit discovery (or the probe) again.
    const second = await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(second?.vesselId).toBe('v-alive');
    expect(resolveCalls()).toBe(1);
    expect(calls.filter((u) => u.endsWith('/health')).length).toBe(1);
  });

  test('walks past a dead first row to a healthy sibling', async () => {
    routeFetch({
      vessels: [
        vesselRow('v-stale', 'http://127.0.0.1:18401'),
        vesselRow('v-alive', 'http://alive.test:9000'),
      ],
      healthy: ['http://alive.test:9000'],
    });

    const found = await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(found?.vesselId).toBe('v-alive');
  });

  test('healthy sibling result is cached (dead row does not poison the cache)', async () => {
    const calls: string[] = [];
    routeFetch({
      vessels: [
        vesselRow('v-stale', 'http://127.0.0.1:18401'),
        vesselRow('v-alive', 'http://alive.test:9000'),
      ],
      healthy: ['http://alive.test:9000'],
      calls,
    });

    await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    const second = await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(second?.vesselId).toBe('v-alive');
    expect(calls.filter((u) => u === `${DISCOVERY}/resolve`).length).toBe(1);
  });

  test('all rows dead: returns first row but does NOT cache it', async () => {
    const calls: string[] = [];
    routeFetch({
      vessels: [
        vesselRow('v-stale-1', 'http://127.0.0.1:18401'),
        vesselRow('v-stale-2', 'http://127.0.0.1:18402'),
      ],
      healthy: [],
      calls,
    });

    const first = await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(first?.vesselId).toBe('v-stale-1');

    // Not cached: the next call re-queries discovery and re-probes.
    await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(calls.filter((u) => u === `${DISCOVERY}/resolve`).length).toBe(2);
  });

  test('prefers public_endpoint for the health probe when present', async () => {
    const calls: string[] = [];
    routeFetch({
      vessels: [vesselRow('v-pub', 'http://internal:8000', { public_endpoint: 'http://pub.test:9100' })],
      healthy: ['http://pub.test:9100'],
      calls,
    });

    const found = await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' });
    expect(found?.vesselId).toBe('v-pub');
    expect(calls).toContain('http://pub.test:9100/health');
  });

  test('empty vessel list still caches null', async () => {
    const calls: string[] = [];
    routeFetch({ vessels: [], healthy: [], calls });

    expect(await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' })).toBeNull();
    expect(await discoverFirstVesselByShape({ discoveryEndpoint: DISCOVERY, shape: 'goal_execution' })).toBeNull();
    expect(calls.filter((u) => u === `${DISCOVERY}/resolve`).length).toBe(1);
  });
});

describe('registry_query vessels-mode cross-check against /registry/shapes', () => {
  const apiClient = { getDiscoveryEndpoint: () => undefined } as any;

  function routeRegistry(options: {
    vessels: unknown[];
    shapesResponse?: () => Response | Promise<Response>;
  }): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${DISCOVERY}/resolve`) {
        return new Response(JSON.stringify({ content: { vessels: options.vessels } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === `${DISCOVERY}/registry/shapes`) {
        if (options.shapesResponse) return options.shapesResponse();
        return new Response(JSON.stringify({ shapes: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  }

  beforeEach(() => {
    process.env.DISCOVERY_ENDPOINT = DISCOVERY;
  });

  test('agreeing views: no warning', async () => {
    routeRegistry({
      vessels: [{ vesselId: 'goal-host', endpoint: 'http://gh:8400' }],
      shapesResponse: () => new Response(JSON.stringify({ shapes: ['goal_execution', 'memoryNote'] }), { status: 200 }),
    });

    const out = await registryQueryHandle({ mode: 'vessels', shape: 'goal_execution' }, apiClient);
    expect(out).toContain('Vessels serving "goal_execution" (1):');
    expect(out).not.toContain('WARNING');
  });

  test('vessels advertise a shape the shape list lacks: flagged', async () => {
    routeRegistry({
      vessels: [{ vesselId: 'goal-host', endpoint: 'http://127.0.0.1:18401' }],
      shapesResponse: () => new Response(JSON.stringify({ shapes: ['memoryNote'] }), { status: 200 }),
    });

    const out = await registryQueryHandle({ mode: 'vessels', shape: 'goal_execution' }, apiClient);
    expect(out).toContain('Vessels serving "goal_execution" (1):');
    expect(out).toContain('WARNING: registry views disagree');
    expect(out).toContain('/registry/shapes does not list it');
  });

  test('shape listed but no vessels advertise it: flagged', async () => {
    routeRegistry({
      vessels: [],
      shapesResponse: () => new Response(JSON.stringify({ shapes: ['goal_execution'] }), { status: 200 }),
    });

    const out = await registryQueryHandle({ mode: 'vessels', shape: 'goal_execution' }, apiClient);
    expect(out).toContain('No vessels advertise shape "goal_execution".');
    expect(out).toContain('WARNING: registry views disagree');
    expect(out).toContain('no vesselCapability rows advertise it');
  });

  test('shapes endpoint unreachable: cross-check silently skipped', async () => {
    routeRegistry({
      vessels: [{ vesselId: 'goal-host', endpoint: 'http://gh:8400' }],
      shapesResponse: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const out = await registryQueryHandle({ mode: 'vessels', shape: 'goal_execution' }, apiClient);
    expect(out).toContain('Vessels serving "goal_execution" (1):');
    expect(out).not.toContain('WARNING');
  });
});
