/**
 * WHICH protocol submitFiles speaks, and what it does with an answer it cannot read.
 *
 * Two failures this pins, both found by review rather than by the suite:
 *
 * 1. Routing the vessel branch to the shape protocol is right for a substrate
 *    and wrong for the legacy host. `vesselMode` defaults to ON, so the default
 *    single-key configuration points that branch at ide.metabob.com — which
 *    serves `/v2/mcp/analysis/run` (401 unauthenticated: alive and auth-gated)
 *    and does NOT serve `/resolve` (404). Rerouting everyone would have broken
 *    the deployment most users actually have.
 *
 * 2. A 200 in an unrecognised dialect was counted as an analysed, clean file.
 *    `{seeds:[…]}` — the legacy host's own format — became unrecognised in the
 *    migration, so real findings would have been dropped while the tool reported
 *    success. That is b758ba5's defect ("complete after nothing was analysed")
 *    reappearing one format-migration later, which is why it is asserted on the
 *    RESULT rather than on a mock.
 */
import { test, expect, afterEach } from 'bun:test';
import { AnalysisAPIClient, extractProblemDetectionPayload, isRecognisedProblemDetectionPayload } from '../../src/api-client';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Record every URL the client touches, and answer each with a canned body. */
function captureFetch(answer: (url: string) => { status: number; body: unknown }) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const { status, body } = answer(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return urls;
}

function client(baseURL: string, activityApiUrl?: string): AnalysisAPIClient {
  return new AnalysisAPIClient({ baseURL, activityApiUrl, apiKey: 'k', vesselMode: true });
}

const FILES = [{ path: '/w/a.ts', content: 'export const a = 1;\n' }];

test('legacy host keeps the REST path — it is alive there and /resolve is not', async () => {
  const urls = captureFetch(() => ({ status: 200, body: { seeds: [] } }));
  const res = await client('https://ide.metabob.com').submitFiles(FILES, 's');

  expect(urls.some(u => u.includes('/v2/mcp/analysis/run'))).toBe(true);
  expect(urls.some(u => u.endsWith('/resolve'))).toBe(false);
  expect(res.status).toBe('complete');
});

test('a substrate gets the shape protocol, never the REST path', async () => {
  const urls = captureFetch(() => ({ status: 200, body: { shape: 'problem_detection', problems: [], files_analyzed: 1 } }));
  const res = await client('http://localhost:19250').submitFiles(FILES, 's');

  expect(urls.some(u => u.endsWith('/resolve'))).toBe(true);
  expect(urls.some(u => u.includes('/v2/mcp/analysis/run'))).toBe(false);
  expect(res.status).toBe('complete');
});

test('the legacy {seeds:[…]} body is understood, not silently dropped', async () => {
  captureFetch(() => ({
    status: 200,
    body: { seeds: [{ file: '/w/a.ts', line: 3, severity: 'high', category: 'correctness', message: 'unchecked cast' }] },
  }));
  const res = await client('https://ide.metabob.com').submitFiles(FILES, 's');

  // The finding must survive the format migration.
  expect(res.results?.length).toBe(1);
  expect(res.results?.[0]?.summary).toContain('unchecked cast');
  expect(res.failed ?? 0).toBe(0);
});

test('a 200 in an unknown dialect FAILS the file instead of reporting it clean', async () => {
  // The exact hole: three bodies that were byte-identical in their outcome, one
  // of which carried a real finding.
  captureFetch(() => ({ status: 200, body: { unexpected: 'dialect' } }));
  const res = await client('http://localhost:19250').submitFiles(FILES, 's');

  expect(res.status).toBe('failed');
  expect(res.failed).toBe(1);
  expect(res.failures?.[0]?.reason).toContain('unrecognised');
  // A clean file and an unreadable answer must not look the same.
  expect(res.results ?? []).toHaveLength(0);
});

test('a genuinely clean file is still reported clean, not failed', async () => {
  // Guards the inverse: failing every empty result would satisfy the test above
  // while making the tool useless.
  captureFetch(() => ({ status: 200, body: { shape: 'problem_detection', problems: [], files_analyzed: 1 } }));
  const res = await client('http://localhost:19250').submitFiles(FILES, 's');

  expect(res.status).toBe('complete');
  expect(res.failed ?? 0).toBe(0);
});

test('payload recognition is decided by shape, not by emptiness', () => {
  expect(isRecognisedProblemDetectionPayload({ problems: [] })).toBe(true);
  expect(isRecognisedProblemDetectionPayload({ files_analyzed: 0 })).toBe(true);
  expect(isRecognisedProblemDetectionPayload({ error: 'boom' })).toBe(true);
  expect(isRecognisedProblemDetectionPayload({})).toBe(false);

  expect(extractProblemDetectionPayload({ seeds: [{ message: 'x' }] }).problems).toHaveLength(1);
  expect(extractProblemDetectionPayload({ resolved: [{ content: [{ message: 'y' }] }] }).problems).toHaveLength(1);
});
