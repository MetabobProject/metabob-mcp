/**
 * W3 — attachment conformance (docs/CONFORMANCE.md): what the server does to
 * the substrate just by being started and used, whatever the agent asks of it.
 *
 *   - it never registers with discovery (CONFORMANCE §c11-attachment-model:
 *     client-only until an outside-vantage reachability probe exists);
 *   - its HTTP server binds loopback only (CONFORMANCE §c2-endpoint);
 *   - it does not offer human_input (CONFORMANCE §c7-shapes);
 *   - no workspace content leaves the machine;
 *   - it proves its key against the identity /bootstrap names before any other
 *     keyed call, and a foreign key turns every substrate tool into one line
 *     naming key_rejected while local tools still work (CONFORMANCE §c3-identity);
 *   - a /bootstrap identity it cannot dial is rehosted onto discovery's host
 *     (census class H1, warned about) and still proven (CONFORMANCE §c4-anchoring).
 */

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { networkInterfaces } from 'node:os';
import { FakeSubstrate, type Service } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

// Each server boot is a process spawn; slow CI runners need more than the 5 s default.
setDefaultTimeout(30_000);
const BOOT_TIMEOUT_MS = 30_000;

const MARKER = 'WORKSPACE_CONTENT_MARKER_7f3a9c';

let fake: FakeSubstrate;
const servers: McpServer[] = [];

async function start(name: string, env: Record<string, string | undefined> = {}, files: Record<string, string> = {}): Promise<McpServer> {
  const server = await McpServer.start({ workspace: makeWorkspace(name, files), env: { ...fake.env(), ...env } });
  servers.push(server);
  return server;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

function nonLoopbackIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

let plain: McpServer;

/** /health's attachment field, once the attachment has settled. */
async function settledAttachment(server: McpServer): Promise<any> {
  const port = await server.vesselPort();
  for (let i = 0; i < 100; i++) {
    const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { attachment: any };
    if (body.attachment?.auth?.status !== 'pending') return body.attachment;
    await Bun.sleep(100);
  }
  throw new Error('the attachment did not settle');
}

/** A discovery port on the published-port convention (…100) with identity at the next port, both free. */
async function conventionPorts(): Promise<{ discovery: number; identity: number } | null> {
  for (let p = 40100; p <= 64100; p += 1000) {
    try {
      const a = Bun.serve({ hostname: '127.0.0.1', port: p, fetch: () => new Response() });
      const b = Bun.serve({ hostname: '127.0.0.1', port: p + 1, fetch: () => new Response() });
      a.stop(true);
      b.stop(true);
      return { discovery: p, identity: p + 1 };
    } catch {
      // taken; try the next block
    }
  }
  return null;
}

async function portIsClosed(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }).then(() => false, () => true);
}

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  plain = await start('attach-ws', {}, { 'src/secret.ts': `export const s = '${MARKER}';\n` });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(servers.map(s => s.stop()));
  await fake?.stop();
  cleanupTempDirs();
}, BOOT_TIMEOUT_MS);

describe('W3 attachment conformance', () => {
  // CONFORMANCE §c11-attachment-model: inbound is offered only after an
  // outside-vantage reachability probe, and none exists for host vessels, so
  // the server is client-only under every configuration, whatever variables
  // the environment carries (VESSEL_PUBLIC_ENDPOINT, METABOB_AGENT_RESOLVER
  // and VESSEL_ID included).
  test('no discovery /register under any configuration', async () => {
    const [healthPort, pinnedPort] = await Promise.all([freePort(), freePort()]);
    await Promise.all([
      start('attach-port', { HEALTH_PORT: String(healthPort) }),
      start('attach-pinned', { HEALTH_PORT: String(pinnedPort), VESSEL_PUBLIC_ENDPOINT: `http://127.0.0.1:${pinnedPort}` }),
      start('attach-resolver', { METABOB_AGENT_RESOLVER: '1' }),
      start('attach-vesselid', { VESSEL_ID: 'metabob-mcp-explicit' }),
    ]);
    // Startup work runs before the MCP transport connects, so by the time a
    // server has answered `initialize` anything it would send at boot is sent.
    expect(fake.requestsFor('register')).toEqual([]);
    expect(fake.requests.filter(r => r.service === 'discovery' && r.method !== 'GET')).toEqual([]);
  });

  test('the vessel resolver does not advertise human_input', async () => {
    const port = await plain.vesselPort();
    const caps = (await (await fetch(`http://127.0.0.1:${port}/v2/capabilities`)).json()) as { shapes: string[] };
    expect(caps.shapes.length).toBeGreaterThan(0);
    expect(caps.shapes).not.toContain('human_input');
  });

  // CONFORMANCE §c2-endpoint: loopback is dialable only within the same network
  // namespace, and a client-only process has no reader outside it.
  test('the vessel HTTP server answers on loopback', async () => {
    const port = await plain.vesselPort();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) });
    expect(res.status).toBe(200);
    // CONFORMANCE §c9-fail-visibly: the attachment state is reported.
    const attachment = await settledAttachment(plain);
    expect(attachment).toMatchObject({
      attached: true,
      advertised: 'none (client-only)',
      anchor: { discovery: fake.url('discovery'), source: 'explicit' },
      bootstrap: { status: 'ok', identityEndpoint: fake.url('identity') },
      identity: { endpoint: fake.url('identity'), source: 'bootstrap', tried: [fake.url('identity')] },
      auth: { status: 'authenticated', orgId: fake.orgId },
      cause: null,
    });
  });

  // CONFORMANCE §c3-identity: the key is proven against the substrate's own
  // identity before any other keyed call; a foreign key is refused there.
  test('a foreign key is rejected once, and substrate tools say key_rejected in one line', async () => {
    const own = await FakeSubstrate.start();
    try {
      const server = await McpServer.start({
        workspace: makeWorkspace('foreign-key'),
        env: { ...own.env(), METABOB_API_KEY: 'mb_foreign_namespace_key' },
      });
      servers.push(server);
      for (const [tool, args] of [
        ['registry_query', { mode: 'shapes' }],
        ['concept_search', { query: 'x' }],
        ['run_goal_async', { goal: 'g' }],
        ['execution_trace', { execution_id: 'e1' }],
      ] as const) {
        const r = await server.call(tool, args);
        expect(r.error, tool).toBeUndefined();
        expect(r.isError, tool).toBe(true);
        expect(r.text, tool).toStartWith('key_rejected:');
        expect(r.text.split('\n'), tool).toHaveLength(1);
        expect(r.text, tool).not.toContain('mb_foreign_namespace_key');
      }
      // Local tools still work, and a mixed tool says why its substrate half is absent.
      expect(await server.text('init_workspace', {})).toMatch(/Local index:/);
      expect(await server.text('get_problems', {})).toContain('key_rejected');
      const recorded = await server.text('record_finding', { files: ['src/index.ts'], summary: 'x', severity: 'LOW', category: 'bug' });
      expect(recorded).toContain('key_rejected');

      const attachment = await settledAttachment(server);
      expect(attachment).toMatchObject({ attached: false, cause: 'key_rejected', auth: { status: 'key_rejected' } });
      expect(server.stderr).toContain('key_rejected');
      // The only keyed call was the org check: discovery saw /bootstrap and nothing else.
      expect(own.requests.map(r => `${r.service} ${r.method} ${r.path}`).sort()).toEqual([
        'discovery GET /bootstrap',
        'identity GET /health',
        'identity POST /v1/auth/resolve',
      ]);
    } finally {
      await own.stop();
    }
  });

  // CONFORMANCE §c4-anchoring: a live substrate's /bootstrap names its identity
  // at a container-internal address; the H1 rehost maps it onto discovery's host
  // at discovery's published-port offset, warns, and the org check proves it.
  test('an undialable /bootstrap identity is rehosted (H1), warned about, and proven', async () => {
    const ports = await conventionPorts();
    const advertisedPort = 8101;
    if (!ports || !(await portIsClosed(advertisedPort))) {
      console.warn('skipping the H1 rehost scenario: no free …100 port block, or 127.0.0.1:8101 is in use');
      return;
    }
    const pinned: Partial<Record<Service, number>> = { discovery: ports.discovery, identity: ports.identity };
    const own = await FakeSubstrate.start({ ports: pinned });
    own.bootstrapIdentity = `http://127.0.0.1:${advertisedPort}`;
    try {
      const server = await McpServer.start({ workspace: makeWorkspace('rehost'), env: own.env() });
      servers.push(server);
      const attachment = await settledAttachment(server);
      expect(attachment).toMatchObject({
        attached: true,
        identity: {
          endpoint: own.url('identity'),
          source: 'rehosted-h1',
          advertised: 'http://127.0.0.1:8101',
          tried: ['http://127.0.0.1:8101', own.url('identity')],
        },
        auth: { status: 'authenticated', orgId: own.orgId },
      });
      expect(server.stderr).toMatch(/\[WARN\].*http:\/\/127\.0\.0\.1:8101.*H1/);
      const shapes = await server.text('registry_query', { mode: 'shapes' });
      expect(shapes).not.toMatch(/^(key_rejected|identity_unreachable)/);
      expect(shapes).toStartWith('Advertised shapes');
    } finally {
      await own.stop();
    }
  });

  const lanAddress = nonLoopbackIPv4();
  test.skipIf(!lanAddress)('the vessel HTTP server does not answer on a non-loopback address', async () => {
    const port = await plain.vesselPort();
    const reached = await fetch(`http://${lanAddress}:${port}/health`, { signal: AbortSignal.timeout(3_000) })
      .then(() => true, () => false);
    expect(reached).toBe(false);
  });

  // No workspace content leaves the machine (user ruling 2026-10-13: no uploads).
  test('no workspace content is sent to the substrate', async () => {
    const out = await plain.text('init_workspace', {});
    expect(out).toMatch(/Local index:\s*[1-9]\d*\/\d+ files parsed/);
    await Bun.sleep(2_500); // long enough for any background sender to fire
    const leaked = fake.requests.filter(r => r.rawBody.includes(MARKER));
    expect(leaked.map(r => `${r.service} ${r.method} ${r.path}`)).toEqual([]);
  });

  test('stdout carries only JSON-RPC', () => {
    for (const s of servers) expect(s.strayStdout).toEqual([]);
  });
});
