/**
 * Audit findings 12 and 24 — mark_complete's concept-id handling.
 *
 * 12: concept-db returns ids both bare and ⟨⟩-wrapped, and the wrapped form is
 *     what get_problems prints. On HEAD the wrapped form failed the
 *     `startsWith('concept_')` gate and fell through to the legacy postFeedback
 *     path — reporting "endorsed" for a finding write that never happened.
 * 24: the remote verdict was keyed on `remote.findingId || problem_id`, but
 *     record_finding writes the truthy placeholder "(not cached locally)" into
 *     `finding_ids:` when it has no LocalStore, so the `||` never fell back and
 *     every stateless finding's verdict collided on one un-joinable key.
 *
 * The assertions are on the WIRE and on the STORE: which URL was fetched, what
 * the posted verdict body says, which seed mutation ran. "The mock was called"
 * is precisely the assertion that cannot catch either bug.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test';
import * as MarkComplete from '../../src/tools/mark-complete';
import type { AnalysisAPIClient } from '../../src/api-client';
import type { LocalStore, SeedRecord } from '../../src/local-store';

const realFetch = globalThis.fetch;
const realConceptDbUrl = process.env.CONCEPT_DB_URL;
const realVesselId = process.env.VESSEL_ID;

const SESSION = 'sess-1';
const WRAPPED = '⟨concept_ABC⟩';
const PLAIN = 'concept_ABC';

interface Call { url: string; method: string; body?: string }

function stubFetch(handler: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: String(init?.method ?? 'GET'), body: init?.body as string | undefined });
    return handler(url);
  }) as unknown as typeof fetch;
  return calls;
}

function seed(overrides: Partial<SeedRecord> = {}): SeedRecord {
  return {
    id: 'agf_local1',
    workspace_id: '/w',
    file_path: 'src/x.ts',
    line_start: 1,
    line_end: 2,
    category: 'correctness',
    severity: 'HIGH',
    brief: 'a recorded finding',
    confidence: 1,
    refs_json: JSON.stringify([`concept:${PLAIN}`]),
    produced_at: 0,
    read_at: null,
    stale: false,
    ...overrides,
  };
}

interface StoreSpy {
  store: LocalStore;
  refLookups: string[];
  staled: string[];
  deleted: string[];
}

function storeSpy(byRef: Record<string, SeedRecord>): StoreSpy {
  const spy: StoreSpy = { refLookups: [], staled: [], deleted: [], store: null as never };
  spy.store = {
    getSeedByConceptRef: (id: string) => {
      spy.refLookups.push(id);
      return byRef[id] ?? null;
    },
    getSeedById: () => null,
    markSeedStaleById: (id: string) => { spy.staled.push(id); },
    deleteSeed: (id: string) => { spy.deleted.push(id); },
  } as unknown as LocalStore;
  return spy;
}

/** apiClient stub: postFeedback must NEVER fire on a finding id. */
function apiStub(): { client: AnalysisAPIClient; feedback: string[] } {
  const feedback: string[] = [];
  const client = {
    postFeedback: async (id: string) => { feedback.push(id); },
    hasDiscovery: () => false,
    getDiscoveryEndpoint: () => undefined,
  } as unknown as AnalysisAPIClient;
  return { client, feedback };
}

/** A concept-db row whose `finding_ids:` line holds `ids`. */
function conceptRow(ids: string): Response {
  return new Response(
    JSON.stringify({
      summary: 'a recorded finding',
      content: [
        'repo: metabob-mcp',
        'files: src/x.ts',
        'severity: HIGH',
        `finding_ids: ${ids}`,
      ].join('\n'),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function findingLine(body: string | undefined): string | undefined {
  const content = String((JSON.parse(body ?? '{}') as { content?: string }).content ?? '');
  return content.split('\n').find((l) => l.startsWith('finding: '));
}

beforeEach(() => {
  // Keep identity resolution offline and deterministic.
  process.env.VESSEL_ID = 'test-vessel';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realConceptDbUrl === undefined) delete process.env.CONCEPT_DB_URL;
  else process.env.CONCEPT_DB_URL = realConceptDbUrl;
  if (realVesselId === undefined) delete process.env.VESSEL_ID;
  else process.env.VESSEL_ID = realVesselId;
});

// ── Finding 12 ──────────────────────────────────────────────────────────────

test('mark_complete: a ⟨⟩-wrapped concept id retires the local seed instead of falling through to postFeedback', async () => {
  delete process.env.CONCEPT_DB_URL; // isolate the local half
  const spy = storeSpy({ [PLAIN]: seed() });
  const { client, feedback } = apiStub();

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: WRAPPED, action: 'endorse' }),
    client,
    SESSION,
    spy.store,
  );

  // HEAD: gate missed, so postFeedback fired and the seed was never touched.
  expect(feedback).toEqual([]);
  expect(spy.staled).toEqual(['agf_local1']);
  expect(spy.deleted).toEqual([]);
  expect(out).toContain('agf_local1');
  expect(out).toContain('endorsed');
});

test('mark_complete: a ⟨⟩-wrapped concept id discards via the local store, not the legacy API', async () => {
  delete process.env.CONCEPT_DB_URL;
  const spy = storeSpy({ [PLAIN]: seed() });
  const { client, feedback } = apiStub();

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: WRAPPED, action: 'discard' }),
    client,
    SESSION,
    spy.store,
  );

  expect(feedback).toEqual([]);
  expect(spy.deleted).toEqual(['agf_local1']);
  expect(spy.staled).toEqual([]);
});

test('mark_complete: a seed whose refs_json kept the wrapper still resolves, and the usage id is not percent-encoded', async () => {
  process.env.CONCEPT_DB_URL = 'http://conceptdb.test';
  // The seed is reachable by the id as GIVEN, not by the canonical one — this
  // is what postConcept's `^concept:`-only strip leaves in refs_json.
  const spy = storeSpy({ [WRAPPED]: seed({ refs_json: JSON.stringify([`concept:${WRAPPED}`]) }) });
  const { client, feedback } = apiStub();
  const calls = stubFetch(() => new Response('{"id":"concept_v1"}', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_local1', action: 'endorse' }),
    client,
    SESSION,
    { ...spy.store, getSeedById: () => seed({ refs_json: JSON.stringify([`concept:${WRAPPED}`]) }) } as unknown as LocalStore,
  );

  expect(feedback).toEqual([]);
  const usage = calls.find((c) => c.url.includes('/usage'));
  // HEAD: http://conceptdb.test/concepts/%E2%9F%A8concept_ABC%E2%9F%A9/usage → 404
  expect(usage?.url).toBe('http://conceptdb.test/concepts/concept_ABC/usage');
});

test('mark_complete: a wrapped id with no local seed reads the concept by its bare id', async () => {
  process.env.CONCEPT_DB_URL = 'http://conceptdb.test';
  const spy = storeSpy({});
  const { client, feedback } = apiStub();
  const calls = stubFetch((url) =>
    url.endsWith(`/concepts/${PLAIN}`)
      ? conceptRow('agf_remote9')
      : new Response('{"id":"concept_v1"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: WRAPPED, action: 'endorse' }),
    client,
    SESSION,
    spy.store,
  );

  // HEAD: no fetch at all — the wrapped id went to postFeedback.
  expect(feedback).toEqual([]);
  expect(calls.some((c) => c.url === `http://conceptdb.test/concepts/${PLAIN}`)).toBe(true);
  expect(calls.some((c) => c.url.includes('%E2%9F%A8'))).toBe(false);
  expect(out).toContain('endorsed');
});

// ── Finding 24 ──────────────────────────────────────────────────────────────

test('mark_complete: a concept carrying no agf_* id keys its verdict on the concept, never on the placeholder', async () => {
  process.env.CONCEPT_DB_URL = 'http://conceptdb.test';
  const spy = storeSpy({});
  const { client } = apiStub();
  const calls = stubFetch((url) =>
    url.endsWith(`/concepts/${PLAIN}`)
      ? conceptRow('(not cached locally)') // record_finding's stateless placeholder
      : new Response('{"id":"concept_v1"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: PLAIN, action: 'endorse' }),
    client,
    SESSION,
    spy.store,
  );

  const posted = calls.find((c) => c.method === 'POST' && c.url === 'http://conceptdb.test/concepts');
  expect(posted).toBeDefined();
  // HEAD: `finding: (not cached locally)` — one shared key every such verdict
  // collides on, joinable to nothing.
  expect(findingLine(posted?.body)).toBe(`finding: ${PLAIN}`);
  // And the caller is told the join key is not a finding id.
  expect(out).toContain('keyed on');
});

test('mark_complete: a concept carrying a real agf_* id still keys the verdict on it, with no caveat', async () => {
  process.env.CONCEPT_DB_URL = 'http://conceptdb.test';
  const spy = storeSpy({});
  const { client } = apiStub();
  const calls = stubFetch((url) =>
    url.endsWith(`/concepts/${PLAIN}`)
      ? conceptRow('agf_remote9, agf_other')
      : new Response('{"id":"concept_v1"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: PLAIN, action: 'endorse' }),
    client,
    SESSION,
    spy.store,
  );

  const posted = calls.find((c) => c.method === 'POST' && c.url === 'http://conceptdb.test/concepts');
  expect(findingLine(posted?.body)).toBe('finding: agf_remote9');
  expect(out).not.toContain('keyed on');
});
