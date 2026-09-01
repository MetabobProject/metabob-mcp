/**
 * Regression: the heartbeat must keep retrying, because that is what the logs
 * promise ("retrying on the heartbeat interval").
 *
 * onFailure() used to call stop() at 3 consecutive failures. A discovery-vessel
 * that was down for three cycles therefore cost the vessel its registry row for
 * the entire process lifetime — and with `running = false`, setShapes() stopped
 * re-registering too, so init_workspace no longer advertised the CPG shapes.
 */
import { afterEach, expect, test } from 'bun:test';
import type { AuthService } from '../../src/auth-service.js';
import { VesselHeartbeat } from '../../src/vessel-heartbeat.js';

const cleanups: Array<() => void> = [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(pred: () => boolean, deadlineMs = 3000): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

const authStub = {
  bearerTokenIsStale: () => false,
  getBearerToken: () => undefined,
  getIdentityApiKey: () => undefined,
} as unknown as AuthService;

interface Harness {
  heartbeat: VesselHeartbeat;
  attempts: string[][];
  /** Flip registration outcome mid-flight. */
  setOk: (ok: boolean) => void;
}

function harness(shapes: string[] = ['mcp:tool_call']): Harness {
  const attempts: string[][] = [];
  let ok = false;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { shapes?: string[] };
    attempts.push(body.shapes ?? []);
    return ok
      ? new Response('{}', { status: 200 })
      : new Response('discovery down', { status: 503 });
  }) as typeof fetch;

  const heartbeat = new VesselHeartbeat({
    discoveryEndpoint: 'http://discovery.invalid',
    vesselId: 'v-test',
    vesselName: 'test',
    version: '0.0.0',
    endpoint: 'http://127.0.0.1:8080',
    shapes,
    ttl: 300,
    heartbeatIntervalMs: 20,
    authService: authStub,
  });

  cleanups.push(() => {
    heartbeat.stop();
    globalThis.fetch = realFetch;
  });

  return { heartbeat, attempts, setOk: (v: boolean) => { ok = v; } };
}

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test('registration keeps being retried past the third consecutive failure', async () => {
  const h = harness();

  await h.heartbeat.start();
  // Old behaviour: exactly 3 attempts, then running === false, forever.
  const kept = await until(() => h.attempts.length >= 4, 2000);

  expect(kept).toBe(true);
  expect(h.heartbeat.status().running).toBe(true);
});

test('the vessel re-registers when discovery comes back', async () => {
  const h = harness();

  await h.heartbeat.start();
  await until(() => h.attempts.length >= 4, 2000);

  h.setOk(true);
  const recovered = await until(() => h.heartbeat.status().lastRegistered !== undefined, 3000);

  expect(recovered).toBe(true);
  expect(h.heartbeat.status().consecutiveFailures).toBe(0);
});

test('a shape-set that failed to register is retried on the next reconcile', async () => {
  const h = harness(['mcp:tool_call']);

  h.setOk(true);
  await h.heartbeat.start();
  const baseline = h.attempts.length;

  // Law 1 actuator: init_workspace widens the advertised set.
  h.setOk(false);
  await h.heartbeat.setShapes(['mcp:tool_call', 'code:impact_analysis']);
  expect(h.attempts.length).toBe(baseline + 1);

  // The presence-advertiser reconciles with the same desired set every cycle.
  // The old change-detection compared against what we last *wanted*, so this
  // second call short-circuited as "unchanged" and the new shapes were never
  // advertised for the rest of the process.
  h.setOk(true);
  await h.heartbeat.setShapes(['mcp:tool_call', 'code:impact_analysis']);
  expect(h.attempts.length).toBe(baseline + 2);
  expect(h.attempts.at(-1)).toEqual(['mcp:tool_call', 'code:impact_analysis']);

  // Anti-cheat: once accepted, an unchanged set must not re-register.
  await h.heartbeat.setShapes(['mcp:tool_call', 'code:impact_analysis']);
  expect(h.attempts.length).toBe(baseline + 2);
});
