import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildAuthHeader,
  fetchWithBearerFallback,
  preferredAuthScheme,
  _resetAuthSchemeStateForTests,
} from '../../src/auth-header';

afterEach(() => {
  _resetAuthSchemeStateForTests();
});

describe('preferredAuthScheme', () => {
  test('defaults to Bearer for unknown hosts', () => {
    expect(preferredAuthScheme('activity.metabob.com')).toBe('Bearer');
  });
});

describe('buildAuthHeader', () => {
  test('formats Bearer header by default', () => {
    expect(buildAuthHeader('mb_test', 'activity.metabob.com')).toBe('Bearer mb_test');
  });
});

describe('fetchWithBearerFallback', () => {
  test('sends Bearer on first attempt and returns 200 response', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      calls.push({ url, auth });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithBearerFallback({
      url: 'https://activity.metabob.com/v2/events/mcp',
      apiKey: 'mb_k',
      fetchImpl: fakeFetch,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe('Bearer mb_k');
  });

  test('falls back to ApiKey on 401 and marks host sticky', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      calls.push(auth);
      if (auth?.startsWith('Bearer ')) return new Response('', { status: 401 });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const r1 = await fetchWithBearerFallback({
      url: 'https://legacy.metabob.com/x',
      apiKey: 'mb_k',
      fetchImpl: fakeFetch,
      init: { method: 'POST', headers: {}, body: '{}' },
    });
    expect(r1.status).toBe(200);
    expect(calls).toEqual(['Bearer mb_k', 'ApiKey mb_k']);

    // Subsequent call on the same host should skip Bearer.
    const r2 = await fetchWithBearerFallback({
      url: 'https://legacy.metabob.com/y',
      apiKey: 'mb_k',
      fetchImpl: fakeFetch,
      init: { method: 'POST', headers: {}, body: '{}' },
    });
    expect(r2.status).toBe(200);
    expect(calls[calls.length - 1]).toBe('ApiKey mb_k');
    expect(preferredAuthScheme('legacy.metabob.com')).toBe('ApiKey');
  });

  test('does not retry on non-401 errors', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('forbidden', { status: 403 });
    }) as unknown as typeof fetch;

    const res = await fetchWithBearerFallback({
      url: 'https://activity.metabob.com/x',
      apiKey: 'mb_k',
      fetchImpl: fakeFetch,
      init: { method: 'GET', headers: {} },
    });
    expect(res.status).toBe(403);
    expect(calls).toBe(1);
  });
});
