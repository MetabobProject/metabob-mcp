/**
 * Retry discipline in the api-client: what happens ON THE WIRE (request count,
 * reported status) against what the client tells its caller. A
 * mock-was-called assertion cannot tell these apart — the mock is called, the
 * question is how many times.
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
    const err = await capture(() => legacyClient().get('/metrics', {}, 'sess')) as
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
    const err = await capture(() => legacyClient().get('/metrics', {}, 'sess'));
    expect(err).toBeDefined();
    expect(calls.length).toBe(1); // HEAD: 3
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('retry: a 5xx IS still retried — the fix must not become "never retry"', async () => {
  const calls = stubFetch(() => json({ message: 'upstream down' }, 503));
  try {
    const err = await capture(() => legacyClient().get('/metrics', {}, 'sess'));
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
    const res = await legacyClient().get<{ status: string }>('/metrics', {}, 'sess');
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
