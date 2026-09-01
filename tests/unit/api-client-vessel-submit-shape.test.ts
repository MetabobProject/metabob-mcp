/**
 * submitFiles' VESSEL branch must submit over the SHAPE PROTOCOL.
 *
 * The bug these tests pin: the vessel branch POSTed
 * `${activityApiUrl}/v2/mcp/analysis/run`, a path no backend in this
 * deployment serves. Measured against a healthy substrate (dashboard-test,
 * every service green):
 *
 *   POST :19250/v2/mcp/analysis/run → 404      POST :19080/v2/mcp/analysis/run → 404
 *   POST :19250/v2/submit           → 404      POST :19080/v2/submit           → 404
 *   POST :19250/resolve  {"impulse":{"pointer":{"type":"problem_detection",…}}} → 200
 *
 * So the stub below IS the vessel's contract, not a mock of our own code: it
 * serves /resolve and 404s everything else, exactly as the daemon does. A test
 * that only asserted "a mock was called" (audit finding 33) could not see this
 * bug — the old code did call fetch, at an address nothing answers.
 */
import { test, expect, afterEach } from 'bun:test';
// Imports only what HEAD already exports, so these tests fail on the DEFECT
// (the request lands where nothing serves it) rather than on a missing symbol.
import { AnalysisAPIClient } from '../../src/api-client';
import { _resetAuthSchemeStateForTests } from '../../src/auth-header';

const realFetch = globalThis.fetch;

interface Sent { url: string; method: string; body: unknown }

/**
 * Stub global fetch with a VESSEL: `POST /resolve` is answered by `handler`,
 * every other path 404s the way the real daemon does.
 */
function stubVessel(handler: (index: number, pointer: Record<string, unknown>) => Response): Sent[] {
  const sent: Sent[] = [];
  let served = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body); }
    sent.push({ url, method: String(init?.method ?? 'GET'), body });
    if (new URL(url).pathname !== '/resolve') {
      return new Response('Not Found', { status: 404 });
    }
    const pointer = ((body as { impulse?: { pointer?: Record<string, unknown> } })?.impulse?.pointer) ?? {};
    return handler(served++, pointer);
  }) as unknown as typeof fetch;
  return sent;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** No discoveryEndpoint: the direct vessel URL is the deterministic path. */
function vesselClient(): AnalysisAPIClient {
  return new AnalysisAPIClient({
    baseURL: 'http://vessel.test',
    activityApiUrl: 'http://activity.test',
    vesselMode: true,
    apiKey: 'test-key',
  });
}

const PROBLEM = {
  file: '/w/a.ts',
  line: 12,
  column: 0,
  severity: 'low',
  category: 'complexity',
  message: "Function 'huge' is 140 lines long (>80)",
};

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetAuthSchemeStateForTests();
});

// ── The regression: WHERE the request goes, and WHAT is in it ────────────────

test('submitFiles vessel: resolves problem_detection at /resolve — not a REST path the vessel 404s', async () => {
  const sent = stubVessel(() => json({ shape: 'problem_detection', problems: [PROBLEM], files_analyzed: 1 }));
  try {
    const res = await vesselClient().submitFiles([{ path: '/w/a.ts', content: 'const a = 1;\n' }], 'sess-1');

    // 1. The address. HEAD sends this to http://activity.test/v2/mcp/analysis/run.
    expect(sent.map(s => s.url)).toEqual(['http://vessel.test/resolve']);
    expect(sent[0]?.method).toBe('POST');
    expect(sent.some(s => s.url.includes('/v2/mcp/'))).toBe(false);

    // 2. The envelope, verbatim — the shape the live vessel accepted.
    const pointer = (sent[0]?.body as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer;
    expect(pointer['type']).toBe('problem_detection');
    expect(pointer['filePaths']).toEqual(['/w/a.ts']);
    expect(pointer['excerpt']).toBe('const a = 1;\n');
    expect(pointer['language']).toBe('typescript');
    expect(pointer['workspace_id']).toBe('sess-1');
    expect(typeof pointer['request_id']).toBe('string');

    // 3. The vessel's problems become results, with a derived stable id
    //    (the shape returns none, and init_workspace keys seeds on it).
    expect(res.status).toBe('complete');
    expect(res.submitted).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.results?.[0]?.id).toMatch(/^vsp_[0-9a-f]{8}$/);
    expect(res.results).toEqual([{
      path: '/w/a.ts',
      id: res.results?.[0]?.id as string,
      category: 'complexity',
      severity: 'LOW',
      summary: PROBLEM.message,
      description: PROBLEM.message,
      startLine: 12,
      endLine: 12,
      discarded: false,
      endorsed: false,
    }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: the 12000-char excerpt cap is preserved', async () => {
  const sent = stubVessel(() => json({ problems: [] }));
  try {
    await vesselClient().submitFiles([{ path: '/w/big.ts', content: 'x'.repeat(20_000) }], 'sess');
    const pointer = (sent[0]?.body as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer;
    expect(String(pointer['excerpt']).length).toBe(12_000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: a shape resolve is retried on the proxy spelling only when /resolve 404s', async () => {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, method: String(init?.method ?? 'GET'), body: JSON.parse(String(init?.body)) });
    return new URL(url).pathname === '/v2/impulses/resolve'
      ? json({ resolved: [{ content: [PROBLEM], metadata: { files_analyzed: 1 } }] })
      : new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
  try {
    const res = await vesselClient().submitFiles([{ path: '/w/a.ts', content: 'x' }], 'sess');
    expect(sent.map(s => new URL(s.url).pathname)).toEqual(['/resolve', '/v2/impulses/resolve']);
    // The analysis-api `{ resolved: [...] }` envelope unwraps to the same result.
    expect(res.status).toBe('complete');
    expect(res.results?.length).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Failure accounting (b758ba5) must survive the protocol change ────────────

test('submitFiles vessel: HTTP 200 with an {error} body is a FAILURE, not a clean run', async () => {
  // The vessel's own guard: when no requested path could be read it answers
  // 200 with a bare {error}. Trusting the 200 is the b758ba5 bug one layer up.
  stubVessel(() => json({ error: "no analyzable file: ENOENT: no such file or directory, open '/w/a.ts'" }));
  try {
    const res = await vesselClient().submitFiles(
      [{ path: '/w/a.ts', content: 'x' }, { path: '/w/b.ts', content: 'y' }],
      'sess',
    );
    expect(res.status).toBe('failed');
    expect(res.submitted).toBe(0);
    expect(res.failed).toBe(2);
    // status 0 = the resolver answered, but with no HTTP verdict to record.
    expect(res.failures?.map(f => ({ path: f.path, status: f.status }))).toEqual([
      { path: '/w/a.ts', status: 0 },
      { path: '/w/b.ts', status: 0 },
    ]);
    expect(res.failures?.[0]?.reason).toContain('ENOENT');
    expect(res.results).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: a per-file read_error is counted, not reported as a finding', async () => {
  stubVessel(() => json({
    problems: [{ file: '/w/a.ts', line: 0, severity: 'high', category: 'read_error', message: 'ENOENT' }],
    files_analyzed: 1,
  }));
  try {
    const res = await vesselClient().submitFiles([{ path: '/w/a.ts', content: 'x' }], 'sess');
    expect(res.status).toBe('failed');
    expect(res.failed).toBe(1);
    expect(res.failures?.[0]?.status).toBe(0);
    expect(res.results).toEqual([]); // an unreadable file is not a HIGH problem
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: every file rejected reports failed with the HTTP status', async () => {
  stubVessel(() => json({ error: 'boom' }, 500));
  try {
    const res = await vesselClient().submitFiles(
      [{ path: '/w/a.ts', content: 'x' }, { path: '/w/b.ts', content: 'y' }],
      'sess',
    );
    expect(res.status).toBe('failed');
    expect(res.submitted).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.failures?.map(f => ({ path: f.path, status: f.status }))).toEqual([
      { path: '/w/a.ts', status: 500 },
      { path: '/w/b.ts', status: 500 },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: a partial rejection stays complete but distinguishable', async () => {
  stubVessel(i => (i === 0
    ? json({ problems: [PROBLEM], files_analyzed: 1 })
    : json({ error: 'read failed' })));
  try {
    const res = await vesselClient().submitFiles(
      [{ path: '/w/a.ts', content: 'x' }, { path: '/w/b.ts', content: 'y' }],
      'sess',
    );
    expect(res.status).toBe('complete');
    expect(res.submitted).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failures?.[0]?.path).toBe('/w/b.ts');
    expect(res.results?.length).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: a 429 soft-skip is still counted', async () => {
  stubVessel(() => json({ error: 'budget exhausted' }, 429));
  try {
    const res = await vesselClient().submitFiles([{ path: '/w/a.ts', content: 'x' }], 'sess');
    expect(res.status).toBe('failed');
    expect(res.failed).toBe(1);
    expect(res.failures?.[0]?.status).toBe(429);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: an unreachable vessel is a failure per file, never a silent complete', async () => {
  globalThis.fetch = (async () => { throw new TypeError('Unable to connect. Is the computer able to access the url?'); }) as unknown as typeof fetch;
  try {
    const res = await vesselClient().submitFiles([{ path: '/w/a.ts', content: 'x' }], 'sess');
    expect(res.status).toBe('failed');
    expect(res.failures?.[0]?.status).toBe(0);
    expect(res.failures?.[0]?.reason).toContain('Unable to connect');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles vessel: ids are stable across re-submits (seed upsert, not duplicate)', async () => {
  stubVessel(() => json({ problems: [PROBLEM], files_analyzed: 1 }));
  try {
    const c = vesselClient();
    const a = await c.submitFiles([{ path: '/w/a.ts', content: 'x' }], 'sess');
    const b = await c.submitFiles([{ path: '/w/a.ts', content: 'x' }], 'other-sess');
    expect(a.results?.[0]?.id).toBeDefined(); // not vacuously undefined === undefined
    expect(a.results?.[0]?.id).toBe(b.results?.[0]?.id!);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── The legacy backend is a DIFFERENT protocol and must not move ─────────────

test('submitFiles legacy: still multipart POST /v2/submit against ide.metabob.com', async () => {
  const sent: Array<{ url: string; isForm: boolean }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), isForm: init?.body instanceof FormData });
    return json({ status: 'complete', results: [] });
  }) as unknown as typeof fetch;
  try {
    const legacy = new AnalysisAPIClient({ baseURL: 'https://ide.metabob.com', apiKey: 'test-key' });
    const res = await legacy.submitFiles([{ path: '/w/a.ts', content: 'x' }], 'sess');
    expect(sent).toEqual([{ url: 'https://ide.metabob.com/v2/submit', isForm: true }]);
    expect(res.status).toBe('complete');
  } finally {
    globalThis.fetch = realFetch;
  }
});
