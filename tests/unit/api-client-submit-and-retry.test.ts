/**
 * Audit findings 5 and 25 — the api-client half of "success reported for work
 * not performed".
 *
 * Both assert what happened ON THE WIRE (request count, reported status)
 * against what the client told its caller. A mock-was-called assertion cannot
 * distinguish either bug: on HEAD the mock is called, it is called the WRONG
 * NUMBER OF TIMES, and the return value lies about it.
 */
import { test, expect, afterEach } from 'bun:test';
import { AnalysisAPIClient } from '../../src/api-client';

const realFetch = globalThis.fetch;

interface Call { url: string; method: string }

/** Stub global fetch with a handler that sees the 0-based call index. */
function stubFetch(handler: (index: number, url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? 'GET') });
    return handler(calls.length - 1, url);
  }) as unknown as typeof fetch;
  return calls;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * One `problem_detection` finding, in the shape the analysis-vessel returns.
 * The vessel branch submits over the shape protocol (POST /resolve) — see
 * api-client-vessel-submit-shape.test.ts for the wire assertions. The
 * accounting asserted BELOW is unchanged by that move, which is the point.
 */
const PROBLEM = {
  file: 'ok.ts',
  line: 1,
  column: 0,
  severity: 'high',
  category: 'correctness',
  message: 'a real detection',
};

function vesselClient(): AnalysisAPIClient {
  return new AnalysisAPIClient({
    baseURL: 'http://vessel.test',
    activityApiUrl: 'http://activity.test',
    vesselMode: true,
    apiKey: 'test-key',
  });
}

// ── Finding 5 ───────────────────────────────────────────────────────────────

test('submitFiles: a batch where every POST was rejected reports failed, not complete', async () => {
  const calls = stubFetch(() => json({ error: 'boom' }, 500));
  try {
    const res = await vesselClient().submitFiles(
      [{ path: 'a.ts', content: 'x' }, { path: 'b.ts', content: 'y' }],
      'sess',
    );

    expect(calls.length).toBe(2); // both were really attempted
    expect(res.status).toBe('failed'); // HEAD: 'complete'
    expect(res.submitted).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.failures?.map(f => ({ path: f.path, status: f.status }))).toEqual([
      { path: 'a.ts', status: 500 },
      { path: 'b.ts', status: 500 },
    ]);
    expect(res.results).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles: a partial rejection stays complete but is distinguishable from a clean run', async () => {
  const calls = stubFetch((i) =>
    i === 0 ? json({ problems: [PROBLEM], files_analyzed: 1 }, 200) : json({ error: 'boom' }, 500),
  );
  try {
    const res = await vesselClient().submitFiles(
      [{ path: 'ok.ts', content: 'x' }, { path: 'bad.ts', content: 'y' }],
      'sess',
    );

    expect(calls.length).toBe(2);
    // Not 'failed' — one file genuinely landed. The counts are the only signal
    // separating "1 of 2 analyzed" from "2 of 2 analyzed, 1 finding".
    expect(res.status).toBe('complete');
    expect(res.submitted).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failures?.map(f => ({ path: f.path, status: f.status }))).toEqual([
      { path: 'bad.ts', status: 500 },
    ]);
    expect(res.results?.length).toBe(1);
    expect(res.results?.[0]?.path).toBe('ok.ts');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles: a 429 soft-skip is counted, not silently dropped', async () => {
  stubFetch(() => json({ error: 'budget exhausted' }, 429));
  try {
    const res = await vesselClient().submitFiles([{ path: 'a.ts', content: 'x' }], 'sess');

    // The file was never analyzed. Reporting that as a clean 'complete' is the
    // same lie as the 500 case, only quieter — there is not even a stderr line.
    expect(res.status).toBe('failed');
    expect(res.failed).toBe(1);
    expect(res.failures?.map(f => ({ path: f.path, status: f.status }))).toEqual([
      { path: 'a.ts', status: 429 },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('submitFiles: a fully successful batch reports no failures', async () => {
  stubFetch(() => json({ problems: [PROBLEM], files_analyzed: 1 }, 200));
  try {
    const res = await vesselClient().submitFiles([{ path: 'a.ts', content: 'x' }], 'sess');

    expect(res.status).toBe('complete');
    expect(res.submitted).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.failures).toEqual([]);
    expect(res.results?.length).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Finding 25 ──────────────────────────────────────────────────────────────

function legacyClient(): AnalysisAPIClient {
  // retryDelayMs must be >= 1: the constructor's `|| 100` coerces 0 back to 100.
  return new AnalysisAPIClient({
    baseURL: 'http://api.test',
    retryAttempts: 3,
    retryDelayMs: 1,
    apiKey: 'test-key',
  });
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

test('retry: a 400 is not retried — one request, not three', async () => {
  const calls = stubFetch(() => json({ message: 'bad request' }, 400));
  try {
    const err = await capture(() => legacyClient().get('/analysis', {}, 'sess')) as
      { details?: { status?: number } } | undefined;

    expect(err).toBeDefined();
    expect(err?.details?.status).toBe(400); // the real API error reached the caller
    expect(calls.length).toBe(1); // HEAD: 3
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('retry: a 401 is not retried — an expired key costs one round-trip, not three', async () => {
  const calls = stubFetch(() => json({ message: 'unauthorized' }, 401));
  try {
    const err = await capture(() => legacyClient().get('/analysis', {}, 'sess'));
    expect(err).toBeDefined();
    expect(calls.length).toBe(1); // HEAD: 3
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('retry: a 5xx IS still retried — the fix must not become "never retry"', async () => {
  const calls = stubFetch(() => json({ message: 'upstream down' }, 503));
  try {
    const err = await capture(() => legacyClient().get('/analysis', {}, 'sess'));
    expect(err).toBeDefined();
    expect(calls.length).toBe(3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('retry: a 5xx that recovers returns the second response', async () => {
  const calls = stubFetch((i) =>
    i === 0 ? json({ message: 'upstream down' }, 503) : json({ status: 'complete' }, 200),
  );
  try {
    const res = await legacyClient().get<{ status: string }>('/analysis', {}, 'sess');
    expect(res.status).toBe('complete');
    expect(calls.length).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('postFeedback: a rejected non-idempotent write is sent once, not replayed', async () => {
  const calls = stubFetch(() => json({ message: 'unknown problem id' }, 400));
  try {
    const err = await capture(() =>
      legacyClient().postFeedback('p1', 'sess', { endorsed: true }),
    );

    expect(err).toBeDefined();
    const posts = calls.filter((c) => c.method === 'POST');
    // Three identical endorse POSTs against a server that already refused the
    // first is the harm the guard was written to prevent.
    expect(posts.length).toBe(1); // HEAD: 3
    expect(posts[0]?.url).toBe('http://api.test/feedback/detection');
  } finally {
    globalThis.fetch = realFetch;
  }
});
