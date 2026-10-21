/**
 * The attachment (src/attachment.ts): identity selection, each named cause, the
 * H1 warnings, the gate keyed calls pass through, and /health's report of it.
 * Every network call goes through a scripted fetch, so each test states exactly
 * which addresses answer and how — and asserts which were contacted.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  attach,
  rehostH1Identity,
  setAttachment,
  substrateRefusal,
  AttachmentRefusedError,
  type AttachOptions,
} from '../../src/attachment';
import { AuthService } from '../../src/auth-service';
import { applyConfigDefaults, derivedDiscoveryWarning, discoveryEndpointSource, loadMetabobCLIConfig } from '../../src/config';
import { VesselServer, resolveImpulseContent } from '../../src/vessel-server';
import { substrateToolRefusal } from '../../src/tools';
import { CircuitState } from '../../src/circuit-breaker';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = 'mb_good_key';
const ORG = 'org_123';

type Responder = (req: Request) => Response | Promise<Response>;

interface Script {
  /** url prefix (scheme://host:port) → responder; absent → connection refused. */
  hosts: Record<string, Responder>;
}

function scriptedFetch(script: Script) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const url = new URL(req.url);
    calls.push({ method: req.method, url: req.url, auth: req.headers.get('authorization') });
    const responder = script.hosts[url.origin];
    if (!responder) throw new TypeError(`fetch failed: connect ECONNREFUSED ${url.host}`);
    return responder(req);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const html = (status = 200) => new Response('<html><body>Sign in</body></html>', { status, headers: { 'content-type': 'text/html' } });

function bootstrapAt(identity: string): Responder {
  return (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/bootstrap') {
      return json({ relay_multiaddrs: [], identity_endpoint: identity, discovery_endpoint: '', prefer_transport: 'libp2p' });
    }
    if (path === '/resolve') return json({ content: { found: true } });
    return json({ error: 'not found' }, 404);
  };
}

/** identity-vessel: /health, and the flat-form /v1/auth/resolve accepting only KEY. */
function identity(): Responder {
  return (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/v1/auth/resolve') {
      return req.headers.get('authorization') === `ApiKey ${KEY}`
        ? json({ valid: true, org_id: ORG, user_id: 'u1', key_id: 'k1' })
        : json({ valid: false, error: 'Invalid API key' }, 401);
    }
    return json({}, 404);
  };
}

function run(opts: Partial<AttachOptions> & { script: Script }) {
  const { impl, calls } = scriptedFetch(opts.script);
  const logs: Array<{ level: string; message: string }> = [];
  const a = attach({
    key: KEY,
    heartbeatMs: 0,
    log: (level, message) => logs.push({ level, message }),
    fetchImpl: impl,
    ...opts,
  });
  return { a, calls, logs };
}

afterEach(() => setAttachment(null));

describe('identity selection', () => {
  test('1. an explicit identity wins: no /health probe, bootstrap value unused', async () => {
    const { a, calls } = run({
      discovery: 'http://127.0.0.1:18100',
      identityOverride: 'http://id.example:9000',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101'), 'http://id.example:9000': identity() } },
    });
    const s = await a.settled();
    expect(s.identity).toEqual({ endpoint: 'http://id.example:9000', source: 'explicit', advertised: 'http://127.0.0.1:8101', tried: ['http://id.example:9000'] });
    expect(s.auth).toEqual({ status: 'authenticated', orgId: ORG, keyId: 'k1' });
    expect(s.cause).toBeNull();
    expect(calls.some(c => c.url.endsWith('/health'))).toBe(false);
  });

  test('1b. an explicit identity that is down is not replaced by a guess', async () => {
    const { a } = run({
      discovery: 'http://127.0.0.1:18100',
      identityOverride: 'http://127.0.0.1:8101',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101'), 'http://127.0.0.1:18101': identity() } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('identity_unreachable');
    expect(s.identity.tried).toEqual(['http://127.0.0.1:8101']);
  });

  test('2. a dialable bootstrap identity is used as advertised', async () => {
    const { a, calls } = run({
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://syzygy.example'), 'https://syzygy.example': identity() } },
    });
    const s = await a.settled();
    expect(s.bootstrap).toEqual({ status: 'ok', identityEndpoint: 'https://syzygy.example' });
    expect(s.identity).toEqual({ endpoint: 'https://syzygy.example', source: 'bootstrap', advertised: 'https://syzygy.example', tried: ['https://syzygy.example'] });
    expect(s.auth.status).toBe('authenticated');
    // One bootstrap GET, one /health dial, one org check — nothing else.
    expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /bootstrap', 'GET /health', 'POST /v1/auth/resolve']);
    expect(calls[2]!.auth).toBe(`ApiKey ${KEY}`);
  });

  test('3. an undialable loopback identity is rehosted onto discovery (H1), with the warning', async () => {
    const { a, logs, calls } = run({
      discovery: 'http://127.0.0.1:18100',
      discoverySource: 'derived-h1',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101'), 'http://127.0.0.1:18101': identity() } },
    });
    const s = await a.settled();
    expect(s.anchor).toEqual({ discovery: 'http://127.0.0.1:18100', source: 'derived-h1' });
    expect(s.identity).toEqual({
      endpoint: 'http://127.0.0.1:18101',
      source: 'rehosted-h1',
      advertised: 'http://127.0.0.1:8101',
      tried: ['http://127.0.0.1:8101', 'http://127.0.0.1:18101'],
    });
    expect(s.auth).toMatchObject({ status: 'authenticated', orgId: ORG });
    const warn = logs.find(l => l.level === 'warn');
    expect(warn?.message).toContain('http://127.0.0.1:8101');
    expect(warn?.message).toContain('H1');
    // The rehosted address is dialled once — by the org check itself.
    expect(calls.filter(c => c.url.startsWith('http://127.0.0.1:18101')).map(c => new URL(c.url).pathname)).toEqual(['/v1/auth/resolve']);
  });

  test('3b. a rehosted identity that rejects the key → key_rejected, and no other keyed call', async () => {
    const reject: Responder = (req) => new URL(req.url).pathname === '/v1/auth/resolve'
      ? json({ valid: false }, 401) : json({ status: 'ok' });
    const { a, calls } = run({
      discovery: 'http://127.0.0.1:18100',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101'), 'http://127.0.0.1:18101': reject } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('key_rejected');
    expect(s.identity.source).toBe('rehosted-h1');
    await expect(a.resolve({ type: 'vesselCapability', shape: 'x' })).rejects.toBeInstanceOf(AttachmentRefusedError);
    const keyed = calls.filter(c => c.auth);
    expect(keyed.map(c => c.url)).toEqual(['http://127.0.0.1:18101/v1/auth/resolve']);
  });

  test('3c. a single-label container host (compose) is rehosted at the discovery port offset, not +10000', () => {
    expect(rehostH1Identity('http://substrate-live:8101', 'http://127.0.0.1:26100')).toBe('http://127.0.0.1:26101');
    expect(rehostH1Identity('http://127.0.0.1:8101', 'http://127.0.0.1:18100')).toBe('http://127.0.0.1:18101');
    // Not the H1 class: a public host, a non-8xxx port, or a discovery off the convention.
    expect(rehostH1Identity('https://syzygy.host', 'http://127.0.0.1:28100')).toBeNull();
    expect(rehostH1Identity('http://127.0.0.1:9101', 'http://127.0.0.1:18100')).toBeNull();
    expect(rehostH1Identity('http://127.0.0.1:8101', 'https://hub.example')).toBeNull();
    expect(rehostH1Identity('http://127.0.0.1:8101', 'http://127.0.0.1:18123')).toBeNull();
  });

  test('3d. a rehosted identity that does not answer → identity_unreachable naming advertised and tried', async () => {
    const { a } = run({
      discovery: 'http://127.0.0.1:18100',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101') } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('identity_unreachable');
    expect(s.auth.status).toBe('identity_unreachable');
    expect(s.message).toStartWith('identity_unreachable(advertised=http://127.0.0.1:8101, tried=[http://127.0.0.1:8101, http://127.0.0.1:18101])');
  });

  test('4. an undialable public identity is not rehosted → identity_unreachable', async () => {
    const { a, calls } = run({
      discovery: 'http://127.0.0.1:28100',
      script: { hosts: { 'http://127.0.0.1:28100': bootstrapAt('https://identity.example') } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('identity_unreachable');
    expect(s.identity).toMatchObject({ endpoint: null, advertised: 'https://identity.example', tried: ['https://identity.example'] });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  test('4b. /bootstrap advertising no identity ("") → identity_unreachable(advertised=none)', async () => {
    const { a } = run({
      discovery: 'http://127.0.0.1:18100',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('') } },
    });
    const s = await a.settled();
    expect(s.bootstrap.identityEndpoint).toBeNull();
    expect(s.message).toStartWith('identity_unreachable(advertised=none, tried=[])');
  });
});

describe('named causes', () => {
  test('not_configured: no key', async () => {
    const { a, calls } = run({ key: undefined, discovery: 'http://127.0.0.1:18100', script: { hosts: {} } });
    const s = await a.settled();
    expect(s.cause).toBe('not_configured');
    expect(s.auth.status).toBe('not_configured');
    expect(calls).toEqual([]);
  });

  test('not_configured: no discovery and no explicit identity', async () => {
    const { a, calls } = run({ script: { hosts: {} } });
    const s = await a.settled();
    expect(s.cause).toBe('not_configured');
    expect(s.message).toContain('no discovery endpoint');
    expect(calls).toEqual([]);
  });

  test('anchor_unreachable: discovery does not answer /bootstrap', async () => {
    const { a } = run({ discovery: 'http://127.0.0.1:18100', script: { hosts: {} } });
    const s = await a.settled();
    expect(s.bootstrap.status).toBe('unreachable');
    expect(s.cause).toBe('anchor_unreachable');
    expect(s.message).toStartWith('anchor_unreachable:');
  });

  test('blocked_by_portal: /bootstrap answers HTML', async () => {
    const { a, calls } = run({ discovery: 'http://anchor.example:18100', script: { hosts: { 'http://anchor.example:18100': () => html() } } });
    const s = await a.settled();
    expect(s.bootstrap.status).toBe('not_substrate');
    expect(s.cause).toBe('blocked_by_portal');
    expect(calls.filter(c => c.auth)).toEqual([]);
  });

  test('proxy_refused: a non-JSON 4xx through a proxy names the proxy in the line tools echo', async () => {
    const { a } = run({
      discovery: 'http://anchor.example:18100',
      env: { HTTP_PROXY: 'http://proxy.corp:3128' } as NodeJS.ProcessEnv,
      script: { hosts: { 'http://anchor.example:18100': () => new Response('Forbidden', { status: 403 }) } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('blocked_by_portal');
    expect(s.message).toStartWith('proxy_refused: GET http://anchor.example:18100/bootstrap answered HTTP 403');
    expect(s.message).toContain('it went through the proxy http://proxy.corp:3128, which may be what refused it');
  });

  test('blocked_by_portal: identity answers HTML to the org check', async () => {
    const { a } = run({
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': () => html() } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('blocked_by_portal');
    expect(s.auth.status).toBe('identity_unreachable');
  });

  test('key_rejected: identity answers 401', async () => {
    const { a, logs } = run({
      key: 'mb-invalid',
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': identity() } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('key_rejected');
    expect(s.auth).toEqual({ status: 'key_rejected', detail: 'HTTP 401' });
    expect(s.message).toStartWith('key_rejected:');
    expect(s.message).not.toContain('\n');
    expect(s.message).not.toContain('mb-invalid');
    expect(logs.some(l => l.level === 'warn' && l.message.startsWith('key_rejected'))).toBe(true);
  });

  test('identity_unreachable: identity answers 503', async () => {
    const down: Responder = (req) => new URL(req.url).pathname === '/health' ? json({}) : json({ error: 'down' }, 503);
    const { a } = run({
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': down } },
    });
    const s = await a.settled();
    expect(s.cause).toBe('identity_unreachable');
    expect(s.auth.detail).toBe('HTTP 503');
  });
});

describe('the heartbeat', () => {
  test('re-resolves against the chosen identity and flips to key_rejected when the key is revoked', async () => {
    let revoked = false;
    const id: Responder = (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return json({ status: 'ok' });
      return revoked ? json({ valid: false }, 401) : json({ valid: true, org_id: ORG });
    };
    const authService = new AuthService();
    const { a, calls } = run({
      discovery: 'https://hub.example',
      authService,
      heartbeatMs: 20,
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': id } },
    });
    expect((await a.settled()).cause).toBeNull();
    expect(authService.getOrgId()).toBe(ORG);
    revoked = true;
    for (let i = 0; i < 50 && a.state().cause === null; i++) await Bun.sleep(10);
    a.stop();
    expect(a.state().cause).toBe('key_rejected');
    expect(calls.filter(c => c.url === 'https://id.example/v1/auth/resolve').length).toBeGreaterThan(1);
  });
});

describe('resolve() and the shared gate', () => {
  test('resolve() refuses with the named cause when unauthenticated, sending nothing to discovery', async () => {
    const { a, calls } = run({
      key: 'mb-invalid',
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': identity() } },
    });
    const err = await a.resolve({ type: 'vesselCapability', shape: 'conceptGraph' }).catch(e => e);
    expect(err).toBeInstanceOf(AttachmentRefusedError);
    expect((err as AttachmentRefusedError).attachCause).toBe('key_rejected');
    expect(calls.some(c => c.url.endsWith('/resolve') && c.method === 'POST' && !c.url.includes('/auth/'))).toBe(false);
  });

  test('resolve() posts the pointer to discovery /resolve with the key once authenticated', async () => {
    const { a, calls } = run({
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': identity() } },
    });
    expect(await a.resolve({ type: 'vesselCapability', shape: 'conceptGraph' })).toMatchObject({ status: 200, body: { content: { found: true } } });
    const last = calls.at(-1)!;
    expect(last.url).toBe('https://hub.example/resolve');
    expect(last.auth).toBe(`ApiKey ${KEY}`);
  });

  test('substrate tools refuse in one line on both planes; local tools do not', async () => {
    const { a } = run({
      key: 'mb-invalid',
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': identity() } },
    });
    setAttachment(a);
    expect(await substrateRefusal()).toStartWith('key_rejected:');
    expect(await substrateToolRefusal('registry_query')).toStartWith('key_rejected:');
    expect(await substrateToolRefusal('concept_search')).toStartWith('key_rejected:');
    expect(await substrateToolRefusal('analyze_impact')).toBeNull();
    await expect(resolveImpulseContent({ type: 'mcp:tool_call', tool: 'registry_query', input: { mode: 'shapes' } }, {} as any, 's'))
      .rejects.toThrow(/^key_rejected:/);
  });

  test('with no attachment installed the gate never refuses', async () => {
    expect(await substrateRefusal()).toBeNull();
    expect(await substrateToolRefusal('registry_query')).toBeNull();
  });
});

describe('/health', () => {
  function health() {
    const app = new VesselServer({
      port: 0,
      apiClient: {} as any,
      circuitBreaker: { getState: () => CircuitState.CLOSED, isAllowed: () => true } as any,
      sessionId: 's',
      apiKey: KEY,
      authService: { getIdentityApiKey: () => KEY } as any,
      localStore: null,
    }).buildApp();
    return app.fetch(new Request('http://x/health')).then(r => r.json() as Promise<any>);
  }

  test('authenticated', async () => {
    const { a } = run({
      discovery: 'http://127.0.0.1:18100',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101'), 'http://127.0.0.1:18101': identity() } },
    });
    await a.settled();
    setAttachment(a);
    const body = await health();
    expect(body.attachment).toMatchObject({
      attached: true,
      anchor: { discovery: 'http://127.0.0.1:18100', source: 'explicit' },
      bootstrap: { status: 'ok', identityEndpoint: 'http://127.0.0.1:8101' },
      identity: { endpoint: 'http://127.0.0.1:18101', source: 'rehosted-h1', advertised: 'http://127.0.0.1:8101', tried: ['http://127.0.0.1:8101', 'http://127.0.0.1:18101'] },
      auth: { status: 'authenticated', orgId: ORG },
      cause: null,
      advertised: 'none (client-only)',
    });
    expect(body.attachment.reason).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  test('key_rejected', async () => {
    const { a } = run({
      key: 'mb-invalid',
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': bootstrapAt('https://id.example'), 'https://id.example': identity() } },
    });
    await a.settled();
    setAttachment(a);
    const body = await health();
    expect(body.attachment).toMatchObject({ attached: false, cause: 'key_rejected', auth: { status: 'key_rejected' } });
    expect(body.attachment.reason).toStartWith('key_rejected:');
    expect(JSON.stringify(body)).not.toContain('mb-invalid');
  });

  test('identity_unreachable carries advertised and tried', async () => {
    const { a } = run({
      discovery: 'http://127.0.0.1:18100',
      script: { hosts: { 'http://127.0.0.1:18100': bootstrapAt('http://127.0.0.1:8101') } },
    });
    await a.settled();
    setAttachment(a);
    const body = await health();
    expect(body.attachment).toMatchObject({
      attached: false,
      cause: 'identity_unreachable',
      identity: { advertised: 'http://127.0.0.1:8101', tried: ['http://127.0.0.1:8101', 'http://127.0.0.1:18101'] },
    });
  });

  test('pending reports attaching', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { a } = run({
      discovery: 'https://hub.example',
      script: { hosts: { 'https://hub.example': async (req) => { await gate; return bootstrapAt('https://id.example')(req); }, 'https://id.example': identity() } },
    });
    setAttachment(a);
    const body = await health();
    expect(body.attachment).toMatchObject({ attached: false, reason: 'attaching', auth: { status: 'pending' } });
    release();
    await a.settled();
  });
});

describe('discovery derivation (H1)', () => {
  test('a discovery URL derived from metabob.endpoint is recorded as derived-h1 and warned about', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-cfg-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ metabob: { apiKey: KEY, endpoint: 'http://127.0.0.1:18080' } }));
    const env: NodeJS.ProcessEnv = {};
    applyConfigDefaults(env, loadMetabobCLIConfig(path));
    expect(env.DISCOVERY_ENDPOINT).toBe('http://127.0.0.1:18100');
    expect(discoveryEndpointSource(env)).toBe('derived-h1');
    expect(derivedDiscoveryWarning(env)).toContain('H1');
    expect(derivedDiscoveryWarning(env)).toContain('installer');
  });

  test('metabob.discoveryEndpoint is explicit and draws no warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-cfg-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ metabob: { apiKey: KEY, endpoint: 'http://127.0.0.1:18080', discoveryEndpoint: 'http://127.0.0.1:19100' } }));
    const env: NodeJS.ProcessEnv = {};
    applyConfigDefaults(env, loadMetabobCLIConfig(path));
    expect(discoveryEndpointSource(env)).toBe('explicit');
    expect(derivedDiscoveryWarning(env)).toBeNull();
  });

  test('DISCOVERY_ENDPOINT in the environment is explicit', () => {
    expect(discoveryEndpointSource({ DISCOVERY_ENDPOINT: 'http://127.0.0.1:18100' })).toBe('explicit');
    expect(discoveryEndpointSource({})).toBe('none');
  });
});
