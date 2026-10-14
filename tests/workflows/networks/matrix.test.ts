/**
 * The network matrix (SPEC §network, CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role):
 * for each corporate-network condition, the attachment either attaches — and
 * one read resolves through discovery — or fails within a bound with the named
 * cause. Each row drives the path the tools take — src/attachment.ts over
 * src/net.ts — never doctor's separate probes.
 *
 * Both runtimes that make the calls are covered (SPEC §runtime):
 *   - Bun: the server's runtime. Each row runs attach() in this process.
 *   - Node: `attach --check` and doctor run under Node when Node launched them.
 *     Each row spawns `node <cli.js> attach --check --json` — the built
 *     dist/cli.js under MCP_UNDER_TEST=dist, otherwise a Node bundle of
 *     src/cli.ts built here.
 *
 * Hermetic: an in-process fake substrate (../harness/fake-substrate.ts), TLS
 * fronts and corporate proxies on 127.0.0.1, and certificates minted at test
 * time. Each row's outcome depends only on its own requests: shared proxies and
 * fronts serve every connection independently, and the bounds come from the
 * client's own budgets (CONNECT_BUDGET_MS, BOOTSTRAP_BUDGET_MS), never from a
 * guess at how fast a runner is. Rows run ROW_CONCURRENCY at a time, so a 2-core
 * runner is not asked to complete ~75 TLS handshakes and process starts at
 * once. Proxied host names end in `.invalid`
 * (RFC 6761), which no resolver answers: only the proxy can reach them, and a
 * direct attempt fails as dns_failed at once — on a machine whose resolver
 * answers every name (a hijacking resolver), those two rows cannot hold.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_CONNECT_TIMEOUT_MS } from '../../../src/net';
import { attach, RESOLVE_TIMEOUT_MS, describeResolveFailure, setAttachment, getAttachment } from '../../../src/attachment';
import { VesselServer } from '../../../src/vessel-server';
import { CircuitState } from '../../../src/circuit-breaker';
import { FakeSubstrate } from '../harness/fake-substrate';
import { CorpProxy, closedPort, silentServer, tlsTerminator } from './corp-proxy';
import { makeCa, makeLeaf, type Issued } from './test-ca';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const KEY = 'mb_test_workflow_key';
const PROXY_PASSWORD = 'not-a-real-proxy-password'; // gitleaks:allow (a test fixture)
/**
 * Every row runs with the client's default budgets, so a bound is a property of
 * the client, not of the test: a failure the network answers at once (a 407, a
 * block page, an untrusted chain, NXDOMAIN, a refusal) is named before the
 * connect budget could fire; a blackhole is named when it fires; anything at
 * /bootstrap ends within its response budget, retries included. SLACK_MS covers
 * the work around the request (reading the trust store, the OS proxy read the
 * Node leg makes after a direct failure, scheduling); it never decides a cause.
 */
const CONNECT_BUDGET_MS = DEFAULT_CONNECT_TIMEOUT_MS;
const BOOTSTRAP_BUDGET_MS = 5_000;
const SLACK_MS = 2_500;
/** The one row that sets its own, shorter connect budget. */
const SHORT_CONNECT_MS = 2_000;
/** Rows in flight at once, so the run holds on a 2-core runner; see the header comment. */
const ROW_CONCURRENCY = 4;
/**
 * The Node leg's bound is asserted on the attachment's own clock (the report's
 * startedAt → settledAt), so CI scheduler load on many concurrent processes does
 * not decide it; process wall time gets only this loose cap on top of the bound.
 */
const NODE_WALL_SLACK_MS = 10_000;

type Expect = { attaches: true } | { cause: string; causeArg?: string; withinMs: number };

interface Row {
  id: string;
  /** The network condition (the plan's matrix row). */
  condition: string;
  anchor: () => string;
  env?: () => Record<string, string>;
  expect: Expect;
  /** Extra assertions on the Bun result. */
  check?: (r: RowResult) => void;
}

interface RowResult {
  attached: boolean;
  /** The named cause: the network's, else the attachment's or the resolve's. */
  cause: string | null;
  message: string;
  /** Wall clock of the run: in process for Bun, process start to exit for Node. */
  elapsedMs: number;
  /** The attachment's own time from start to its outcome (Node: the report's startedAt → settledAt). */
  clientMs: number;
  /** Everything the run produced that a person could read: state, logs, output. */
  transcript: string;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let substrateCa: Issued;
let corpCa: Issued;
let fakeLoop: FakeSubstrate; // identity advertised on loopback
let fakeTls: FakeSubstrate; // identity advertised as https://identity.invalid
let fakePlain: FakeSubstrate; // identity advertised as http://plain-identity.invalid:18101
let fakePortal: FakeSubstrate; // /bootstrap answers HTML
const proxies: Record<string, CorpProxy> = {};
const stoppers: Array<() => void | Promise<void>> = [];
let frontLoopPort = 0;
let silentPort = 0;
let refusedPort = 0;
let tmp = '';
let caFileSubstrate = '';
let caFileBoth = '';
let nodeCli = '';
/** The Node leg needs `node` on PATH; CI runners carry it. */
const nodeAvailable = spawnSync('node', ['--version'], { windowsHide: true }).status === 0;

const port = (url: string) => Number(new URL(url).port);

const bunResults = new Map<string, RowResult>();
const nodeResults = new Map<string, RowResult>();
let suiteMs = 0;

function baseEnv(row: Row): Record<string, string> {
  return {
    NODE_EXTRA_CA_CERTS: caFileSubstrate,
    ...(row.env?.() ?? {}),
  };
}

const ROWS: Row[] = [
  {
    id: 'direct',
    condition: 'Direct, no proxy (plain-http anchor)',
    anchor: () => fakeLoop.url('discovery'),
    expect: { attaches: true },
  },
  {
    id: 'direct-https',
    condition: 'Direct, no proxy (https anchor, trusted CA)',
    anchor: () => `https://localhost:${frontLoopPort}`,
    expect: { attaches: true },
  },
  {
    id: 'loopback-bypass',
    condition: 'HTTPS_PROXY set, loopback anchor: the proxy is bypassed',
    anchor: () => fakeLoop.url('discovery'),
    env: () => ({ HTTPS_PROXY: proxies.recording!.url(), HTTP_PROXY: proxies.recording!.url() }),
    expect: { attaches: true },
  },
  {
    id: 'connect-proxy',
    condition: 'Explicit HTTP CONNECT proxy; DNS only through the proxy',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.open!.url() }),
    expect: { attaches: true },
  },
  {
    id: 'no-proxy-host',
    condition: 'NO_PROXY names the anchor: it goes direct (and its name does not resolve here)',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.noproxy!.url(), NO_PROXY: '.example.com,substrate.invalid' }),
    expect: { cause: 'dns_failed', causeArg: 'substrate.invalid', withinMs: CONNECT_BUDGET_MS },
  },
  {
    id: 'basic-auth',
    condition: 'Proxy with Basic auth, credentials in the proxy URL',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.basic!.url({ user: 'corp-user', pass: PROXY_PASSWORD }) }),
    expect: { attaches: true },
  },
  {
    id: 'basic-auth-missing',
    condition: 'Proxy with Basic auth, no credentials',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.basic!.url() }),
    expect: { cause: 'proxy_auth_required', causeArg: 'Basic', withinMs: CONNECT_BUDGET_MS },
  },
  {
    id: 'ntlm',
    condition: 'Proxy with NTLM auth',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.ntlm!.url() }),
    expect: { cause: 'proxy_auth_required', causeArg: 'NTLM', withinMs: CONNECT_BUDGET_MS },
    check: (r) => expect(r.message).toMatch(/px- or cntlm-style/),
  },
  {
    id: 'negotiate',
    condition: 'Proxy with Negotiate (Kerberos) auth',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.negotiate!.url() }),
    expect: { cause: 'proxy_auth_required', causeArg: 'Negotiate', withinMs: CONNECT_BUDGET_MS },
    check: (r) => expect(r.message).toMatch(/px- or cntlm-style/),
  },
  {
    id: 'port-blocked',
    condition: 'CONNECT allowed only to :443, anchor on :8443',
    anchor: () => 'https://substrate.invalid:8443',
    env: () => ({ HTTPS_PROXY: proxies.ssl443!.url() }),
    expect: { cause: 'proxy_port_blocked', causeArg: '8443', withinMs: CONNECT_BUDGET_MS },
  },
  {
    id: 'plain-http-via-proxy',
    condition: 'Plain-HTTP anchor through a proxy that tunnels only to :443 (absolute-form)',
    anchor: () => 'http://plain.invalid:18100',
    env: () => ({ HTTP_PROXY: proxies.ssl443!.url(), HTTPS_PROXY: proxies.ssl443!.url() }),
    expect: { attaches: true },
  },
  {
    id: 'idle-cut-fast',
    condition: 'Proxy cutting idle connections; every call is short',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.idle!.url() }),
    expect: { attaches: true },
  },
  {
    id: 'idle-cut-slow',
    condition: 'Proxy cutting idle connections; the anchor never answers',
    anchor: () => 'http://silent.invalid:18100',
    env: () => ({ HTTP_PROXY: proxies.idle!.url() }),
    expect: { cause: 'connection_reset', withinMs: BOOTSTRAP_BUDGET_MS + SLACK_MS },
  },
  {
    id: 'block-page',
    condition: 'Proxy answering CONNECT with an HTML block page',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.block!.url() }),
    expect: { cause: 'blocked_by_portal', withinMs: CONNECT_BUDGET_MS },
  },
  {
    id: 'block-page-http',
    condition: 'Proxy answering a plain-http request with an HTML block page',
    anchor: () => 'http://plain.invalid:18100',
    env: () => ({ HTTP_PROXY: proxies.block!.url() }),
    expect: { cause: 'blocked_by_portal', withinMs: CONNECT_BUDGET_MS },
  },
  {
    id: 'captive-portal',
    condition: 'Captive portal / impostor: /bootstrap answers HTML',
    anchor: () => fakePortal.url('discovery'),
    expect: { cause: 'blocked_by_portal', withinMs: CONNECT_BUDGET_MS },
  },
  {
    id: 'tls-intercepted',
    condition: 'TLS interception, inspection CA not trusted',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.mitm!.url() }),
    expect: { cause: 'tls_intercepted', causeArg: 'Corp Inspection CA', withinMs: CONNECT_BUDGET_MS },
    check: (r) => expect(r.message).toContain('TLS_INTERCEPTED'),
  },
  {
    id: 'tls-intercepted-trusted',
    condition: 'TLS interception, inspection CA trusted (NODE_EXTRA_CA_CERTS)',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.mitm!.url(), NODE_EXTRA_CA_CERTS: caFileBoth }),
    expect: { attaches: true },
  },
  {
    id: 'blackhole-proxy',
    condition: 'Blackholed proxy (accepts, never answers)',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.blackhole!.url(), METABOB_CONNECT_TIMEOUT_MS: String(SHORT_CONNECT_MS) }),
    expect: { cause: 'connect_timeout', withinMs: SHORT_CONNECT_MS + SLACK_MS },
  },
  {
    id: 'blackhole-default-budget',
    condition: 'Blackholed proxy, the default 5 s connect budget',
    anchor: () => 'https://substrate.invalid',
    env: () => ({ HTTPS_PROXY: proxies.blackhole!.url() }),
    expect: { cause: 'connect_timeout', withinMs: CONNECT_BUDGET_MS + SLACK_MS },
  },
  {
    id: 'connect-refused',
    condition: 'Nothing listens at the anchor',
    anchor: () => `http://127.0.0.1:${refusedPort}`,
    // Windows answers a refused loopback connect only after its SYN retries (~2 s),
    // so this row keeps the default budget: refused must not read as a timeout.
    expect: { cause: 'connect_refused', withinMs: CONNECT_BUDGET_MS + SLACK_MS },
  },
  {
    id: 'silent-anchor',
    condition: 'The anchor accepts and never answers (slow, not blocked)',
    anchor: () => `http://127.0.0.1:${silentPort}`,
    expect: { cause: 'response_timeout', withinMs: BOOTSTRAP_BUDGET_MS + SLACK_MS },
  },
];

// ── Runners ──────────────────────────────────────────────────────────────────

async function runBun(row: Row): Promise<RowResult> {
  const env = { ...baseEnv(row) };
  const logs: string[] = [];
  const started = Date.now();
  const a = attach({
    discovery: row.anchor(),
    key: KEY,
    heartbeatMs: 0,
    env,
    osProxy: async () => null,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  const state = await a.settled();
  let attached = false;
  let message = state.message ?? '';
  let cause: string | null = state.network.cause ?? state.cause;
  if (!state.cause) {
    try {
      const res = await a.resolve({ type: 'vesselRegistry' }, { timeoutMs: RESOLVE_TIMEOUT_MS.discovery, read: true });
      attached = res.status === 200;
      if (!attached) cause = `resolve_http_${res.status}`;
    } catch (err) {
      message = describeResolveFailure(err);
      cause = a.state().network.lastByFamily.discovery?.cause ?? 'resolve_failed';
    }
  }
  const elapsedMs = Date.now() - started;
  let health = '';
  if (row.id === 'basic-auth') {
    // /health reports the network diagnosis; the credential never appears in it.
    const previous = getAttachment();
    setAttachment(a);
    try {
      health = await healthOf();
    } finally {
      setAttachment(previous);
    }
  }
  a.stop();
  return { attached, cause, message, elapsedMs, clientMs: elapsedMs, transcript: [JSON.stringify(a.state()), ...logs, message, health].join('\n') };
}

async function healthOf(): Promise<string> {
  const app = new VesselServer({
    port: 0,
    apiClient: {} as any,
    circuitBreaker: { getState: () => CircuitState.CLOSED, isAllowed: () => true } as any,
    sessionId: 's',
    apiKey: KEY,
    authService: { getIdentityApiKey: () => KEY } as any,
    localStore: null,
  }).buildApp();
  return app.fetch(new Request('http://x/health')).then((r) => r.text());
}

function runNode(row: Row): Promise<RowResult> {
  const home = mkdtempSync(join(tmp, 'home-'));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', USERPROFILE: home, TEMP: tmp, TMP: tmp } : {}),
    HOME: home,
    METABOB_API_KEY: KEY,
    DISCOVERY_ENDPOINT: row.anchor(),
    SUBSTRATE_CONFIG_PATH: join(home, 'no-such-config.json'),
    NO_COLOR: '1',
    ...baseEnv(row),
  };
  for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn('node', [nodeCli, 'attach', '--check', '--json'], { cwd: home, env, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const kill = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(kill);
      const elapsedMs = Date.now() - started;
      let report: any = null;
      try {
        report = JSON.parse(out);
      } catch {
        // reported below
      }
      const settled = report?.state?.settledAt ? Date.parse(report.state.settledAt) - Date.parse(report.state.startedAt) : elapsedMs;
      resolvePromise({
        attached: code === 0 && report?.attached === true,
        clientMs: settled,
        cause: report?.cause ?? `unparsed (exit ${code}): ${err.slice(0, 300)}`,
        message: report?.message ?? '',
        elapsedMs,
        transcript: `${out}\n${err}`,
      });
    });
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-net-'));
  substrateCa = makeCa('Substrate Test Root CA');
  corpCa = makeCa('Corp Inspection CA', 'Corp IT');
  caFileSubstrate = join(tmp, 'substrate-ca.pem');
  caFileBoth = join(tmp, 'both-ca.pem');
  writeFileSync(caFileSubstrate, substrateCa.cert);
  writeFileSync(caFileBoth, substrateCa.cert + corpCa.cert);

  fakeLoop = await FakeSubstrate.start();
  fakeTls = await FakeSubstrate.start();
  fakeTls.bootstrapIdentity = 'https://identity.invalid';
  fakePlain = await FakeSubstrate.start();
  fakePlain.bootstrapIdentity = 'http://plain-identity.invalid:18101';
  fakePortal = await FakeSubstrate.start();
  fakePortal.bootstrapHtml = true;
  stoppers.push(() => fakeLoop.stop(), () => fakeTls.stop(), () => fakePlain.stop(), () => fakePortal.stop());

  const leaf = makeLeaf(substrateCa, ['substrate.invalid', 'identity.invalid', 'localhost', '127.0.0.1']);
  const frontDisc = await tlsTerminator(leaf, port(fakeTls.url('discovery')));
  const frontId = await tlsTerminator(leaf, port(fakeTls.url('identity')));
  const frontLoop = await tlsTerminator(leaf, port(fakeLoop.url('discovery')));
  frontLoopPort = frontLoop.port;
  stoppers.push(() => void frontDisc.server.close(), () => void frontId.server.close(), () => void frontLoop.server.close());

  const silent = await silentServer();
  silentPort = silent.port;
  stoppers.push(silent.stop);
  refusedPort = await closedPort();

  const hosts = {
    'substrate.invalid:443': frontDisc.port,
    'substrate.invalid:8443': frontDisc.port,
    'identity.invalid:443': frontId.port,
    'plain.invalid:18100': port(fakePlain.url('discovery')),
    'plain-identity.invalid:18101': port(fakePlain.url('identity')),
    'silent.invalid:18100': silent.port,
  };
  proxies.recording = await CorpProxy.start({ hosts });
  proxies.noproxy = await CorpProxy.start({ hosts });
  proxies.open = await CorpProxy.start({ hosts });
  proxies.basic = await CorpProxy.start({ hosts, basic: { user: 'corp-user', pass: PROXY_PASSWORD } });
  proxies.ntlm = await CorpProxy.start({ hosts, challenge: ['NTLM'] });
  proxies.negotiate = await CorpProxy.start({ hosts, challenge: ['Negotiate', 'NTLM'] });
  proxies.ssl443 = await CorpProxy.start({ hosts, connectPorts: [443] });
  proxies.idle = await CorpProxy.start({ hosts, idleKillMs: 300 });
  proxies.block = await CorpProxy.start({ hosts, blockPage: true });
  proxies.blackhole = await CorpProxy.start({ hosts, blackhole: true });
  proxies.mitm = await CorpProxy.start({
    hosts: { 'substrate.invalid:443': port(fakeTls.url('discovery')), 'identity.invalid:443': port(fakeTls.url('identity')) },
    mitm: corpCa,
  });
  for (const p of Object.values(proxies)) stoppers.push(() => p.stop());

  // The Node leg: the built CLI, or a Node bundle of the source.
  if (nodeAvailable) {
    if (process.env.MCP_UNDER_TEST === 'dist') {
      nodeCli = join(REPO_ROOT, 'dist', 'cli.js');
      if (!existsSync(nodeCli)) throw new Error(`${nodeCli} not found: run \`bun run build\` for MCP_UNDER_TEST=dist`);
    } else {
      const outdir = join(REPO_ROOT, '.metabob-test', 'net-matrix');
      mkdirSync(outdir, { recursive: true });
      const build = spawnSync('bun', [
        'build', join(REPO_ROOT, 'src', 'cli.ts'), '--target', 'node', '--outdir', outdir,
        '--external', 'onnxruntime-node', '--external', 'tree-sitter', '--external', 'tree-sitter-javascript',
        '--external', 'tree-sitter-python', '--external', 'tree-sitter-typescript',
      ], { cwd: REPO_ROOT, windowsHide: true, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`node bundle failed: ${build.stderr}`);
      nodeCli = join(outdir, 'cli.js');
    }
  }

  // Both legs, a bounded number of rows at a time.
  const started = Date.now();
  const tasks: Array<() => Promise<void>> = [
    ...ROWS.map((row) => async () => { bunResults.set(row.id, await runBun(row)); }),
    ...(nodeAvailable ? ROWS.map((row) => async () => { nodeResults.set(row.id, await runNode(row)); }) : []),
  ];
  let next = 0;
  await Promise.all(Array.from({ length: ROW_CONCURRENCY }, async () => {
    while (next < tasks.length) await tasks[next++]!();
  }));
  suiteMs = Date.now() - started;
}, 180_000);

afterAll(async () => {
  for (const stop of stoppers) await stop();
  const lines = ROWS.map((r) => {
    const b = bunResults.get(r.id);
    const n = nodeResults.get(r.id);
    const fmt = (x?: RowResult) => (x ? `${x.attached ? 'attached' : x.cause} ${x.elapsedMs}ms` : 'n/a');
    return `  ${r.id.padEnd(26)} bun: ${fmt(b).padEnd(44)} node: ${fmt(n)}`;
  });
  console.error(`network matrix (${suiteMs}ms wall clock, ${ROW_CONCURRENCY} rows at a time):\n${lines.join('\n')}`);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold a file briefly.
  }
});

// ── Assertions ───────────────────────────────────────────────────────────────

function assertRow(row: Row, r: RowResult | undefined, wallSlackMs: number) {
  expect(r).toBeDefined();
  if ('attaches' in row.expect) {
    expect({ attached: r!.attached, cause: r!.cause, message: r!.message }).toMatchObject({ attached: true });
  } else {
    expect(r!.attached).toBe(false);
    expect(r!.cause).toBe(row.expect.cause);
    if (row.expect.causeArg) expect(r!.message).toContain(`${row.expect.cause}(`);
    if (row.expect.causeArg) expect(r!.message).toContain(row.expect.causeArg);
    expect(r!.clientMs).toBeLessThan(row.expect.withinMs);
    expect(r!.elapsedMs).toBeLessThan(row.expect.withinMs + wallSlackMs);
  }
}

describe('network matrix — Bun (the server runtime), in process', () => {
  for (const row of ROWS) {
    test(`${row.id}: ${row.condition}`, () => {
      const r = bunResults.get(row.id);
      assertRow(row, r, 0);
      row.check?.(r!);
    });
  }

  test('loopback bypass: with HTTPS_PROXY and HTTP_PROXY set, no loopback request reaches the proxy', () => {
    expect(bunResults.get('loopback-bypass')?.attached).toBe(true);
    expect(nodeAvailable ? nodeResults.get('loopback-bypass')?.attached : true).toBe(true);
    expect(proxies.recording!.requests).toEqual([]);
  });

  test('NO_PROXY: a named host goes direct, never to the proxy', () => {
    expect(proxies.noproxy!.requests).toEqual([]);
  });

  test('the CONNECT proxy tunnels by hostname: the name does not resolve on this machine', async () => {
    await expect(lookup('substrate.invalid')).rejects.toThrow();
    expect(proxies.open!.requests.map((r) => `${r.method} ${r.target}`)).toContain('CONNECT substrate.invalid:443');
  });

  test('the plain-http anchor goes absolute-form through the proxy, not CONNECT', () => {
    const plain = proxies.ssl443!.requests.filter((r) => r.target.startsWith('http://plain.invalid:18100/'));
    expect(plain.length).toBeGreaterThan(0);
    expect(proxies.ssl443!.requests.some((r) => r.method === 'CONNECT' && r.target.startsWith('plain.invalid'))).toBe(false);
  });

  test('Basic credentials reach the proxy and never the state, logs, output or /health', () => {
    const expected = `Basic ${Buffer.from(`corp-user:${PROXY_PASSWORD}`).toString('base64')}`;
    expect(proxies.basic!.requests.some((r) => r.proxyAuthorization === expected)).toBe(true);
    const bun = bunResults.get('basic-auth')!;
    expect(bun.transcript).toContain('"status":"healthy"');
    expect(bun.transcript).toContain('***@127.0.0.1');
    expect(bun.transcript).not.toContain(PROXY_PASSWORD);
    if (nodeAvailable) expect(nodeResults.get('basic-auth')!.transcript).not.toContain(PROXY_PASSWORD);
  });

  test('the whole matrix, both runtimes, stays under 30 s', () => {
    expect(suiteMs).toBeLessThan(30_000);
  });
});

describe('network matrix — Node (attach --check, doctor), spawned', () => {
  for (const row of ROWS) {
    test.skipIf(!nodeAvailable)(`${row.id}: ${row.condition}`, () => {
      assertRow(row, nodeResults.get(row.id), NODE_WALL_SLACK_MS);
    });
  }

  test('in CI the Node leg runs: node is on PATH', () => {
    if (process.env.CI) expect(nodeAvailable).toBe(true);
  });
});
