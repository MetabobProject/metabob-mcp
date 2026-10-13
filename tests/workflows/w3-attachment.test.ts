/**
 * W3 — attachment conformance (docs/CONFORMANCE.md): what the server does to
 * the substrate just by being started and used, whatever the agent asks of it.
 *
 *   - it never registers with discovery (CONFORMANCE §c11-attachment-model:
 *     client-only until an outside-vantage reachability probe exists);
 *   - its HTTP server binds loopback only (CONFORMANCE §c2-endpoint);
 *   - it does not offer human_input (CONFORMANCE §c7-shapes);
 *   - no workspace content leaves the machine.
 */

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { networkInterfaces } from 'node:os';
import { FakeSubstrate } from './harness/fake-substrate';
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
    const body = (await res.json()) as { attachment?: { attached: boolean; advertised: string } };
    expect(body.attachment).toEqual({ attached: true, advertised: 'none (client-only)' });
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
