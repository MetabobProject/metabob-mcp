/**
 * Audit findings 12 and 24 — mark_complete's concept-id handling.
 *
 * 12: concept-db returns ids both bare and ⟨⟩-wrapped, and the wrapped form is
 *     what get_problems prints. On HEAD the wrapped form failed the
 *     `startsWith('concept_')` gate, so the finding was never touched while the
 *     tool reported on it.
 * 24: the remote verdict was keyed on `remote.findingId || problem_id`, but
 *     record_finding writes the truthy placeholder "(not cached locally)" into
 *     `finding_ids:` when it has no LocalStore, so the `||` never fell back and
 *     every stateless finding's verdict collided on one un-joinable key.
 *
 * The assertions are on the WIRE and on the STORE: which pointer was resolved
 * through discovery, what the written verdict says, which seed mutation ran. "The mock was called"
 * is precisely the assertion that cannot catch either bug.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test';
import * as MarkComplete from '../../src/tools/mark-complete';
import type { AnalysisAPIClient } from '../../src/api-client';
import type { LocalStore, SeedRecord } from '../../src/local-store';
import { plainConceptId } from '../../src/tools/_concept-content';
import { setAttachment } from '../../src/attachment';
import { installShapeStub, type ShapeStub } from '../helpers/shape-stub';
import { NO_GIT } from '../helpers/no-git';

const realVesselId = process.env.VESSEL_ID;

const SESSION = 'sess-1';
const WRAPPED = '⟨concept_ABC⟩';
const PLAIN = 'concept_ABC';

/**
 * concept-db behind the attachment: `conceptGraph` answers `row` as the root
 * for PLAIN (404 otherwise), and the writes succeed.
 */
function stubConceptDb(row: Record<string, unknown> | null = null): Promise<ShapeStub> {
  return installShapeStub({
    conceptGraph: (p) => (row && p.concept_id === PLAIN
      ? { body: { content: { root: row, edges: [] } } }
      : { status: 404, body: { error: `Concept not found: ${p.concept_id}` } }),
    concept_create_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'concept_v1' }) } }),
    conceptUsage_write: (p) => ({ body: { success: true, content: JSON.stringify({ id: 'usage_1', outcome: p.usageData?.outcome }) } }),
  });
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
      // Mirror the real store, which normalises the id and matches BOTH stored
      // forms. A double that only matched the exact string was asserting which
      // argument mark_complete passes, not whether the seed is found — so it
      // went red the moment the normalisation moved into the store, where every
      // caller gets it, even though the behaviour under test improved.
      return byRef[plainConceptId(id)] ?? byRef[id] ?? null;
    },
    // Mirrors the real store: a verdict retires every seed sharing the finding's
    // concept, so mark_complete asks for the whole set. This double holds one
    // seed per ref, so the set is that seed.
    getSeedsByConceptRef: (id: string) => {
      const hit = byRef[plainConceptId(id)] ?? byRef[id];
      return hit ? [hit] : [];
    },
    getSeedById: () => null,
    markSeedStaleById: (id: string) => { spy.staled.push(id); },
    deleteSeed: (id: string) => { spy.deleted.push(id); },
  } as unknown as LocalStore;
  return spy;
}

/** apiClient stub: concept-db is reached through the attachment, never the client. */
function apiStub(): { client: AnalysisAPIClient } {
  return { client: {} as AnalysisAPIClient };
}

/** A concept-db row whose `finding_ids:` line holds `ids`. */
function conceptRow(ids: string): Record<string, unknown> {
  return {
    id: `concept:${PLAIN}`,
    summary: 'a recorded finding',
    content: [
      'repo: metabob-mcp',
      'files: src/x.ts',
      'severity: HIGH',
      `finding_ids: ${ids}`,
    ].join('\n'),
  };
}

/** The `finding:` line of the verdict concept a stub received. */
function findingLine(stub: ShapeStub): string | undefined {
  const content = String(stub.calls('concept_create_write')[0]?.conceptData?.content ?? '');
  return content.split('\n').find((l) => l.startsWith('finding: '));
}

beforeEach(() => {
  // Keep identity resolution offline and deterministic.
  process.env.VESSEL_ID = 'test-vessel';
});

afterEach(() => {
  setAttachment(null);
  if (realVesselId === undefined) delete process.env.VESSEL_ID;
  else process.env.VESSEL_ID = realVesselId;
});

// ── Finding 12 ──────────────────────────────────────────────────────────────

test('mark_complete: a ⟨⟩-wrapped concept id retires the local seed', async () => {
  // No attachment installed: the local half alone.
  const spy = storeSpy({ [PLAIN]: seed() });
  const { client } = apiStub();

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: WRAPPED, action: 'endorse' }),
    client,
    SESSION,
    spy.store, NO_GIT,
  );

  // The gate must match the wrapped form, or the seed is never touched.
  expect(out).not.toContain('is not a finding id');
  expect(spy.staled).toEqual(['agf_local1']);
  expect(spy.deleted).toEqual([]);
  expect(out).toContain('agf_local1');
  expect(out).toContain('endorsed');
});

test('mark_complete: a ⟨⟩-wrapped concept id discards via the local store', async () => {
  const spy = storeSpy({ [PLAIN]: seed() });
  const { client } = apiStub();

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: WRAPPED, action: 'discard' }),
    client,
    SESSION,
    spy.store, NO_GIT,
  );

  expect(spy.deleted).toEqual(['agf_local1']);
  expect(spy.staled).toEqual([]);
});

test('mark_complete: a seed whose refs_json kept the wrapper still resolves, and the usage id is not percent-encoded', async () => {
  // The seed is reachable by the id as GIVEN, not by the canonical one — this
  // is what postConcept's `^concept:`-only strip leaves in refs_json.
  const spy = storeSpy({ [WRAPPED]: seed({ refs_json: JSON.stringify([`concept:${WRAPPED}`]) }) });
  const { client } = apiStub();
  const stub = await stubConceptDb();

  await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_local1', action: 'endorse' }),
    client,
    SESSION,
    { ...spy.store, getSeedById: () => seed({ refs_json: JSON.stringify([`concept:${WRAPPED}`]) }) } as unknown as LocalStore, NO_GIT,
  );

  const usage = stub.calls('conceptUsage_write')[0];
  // A wrapped id resolves to nothing at the usage chokepoint.
  expect(usage?.usageData?.concept_id).toBe('concept_ABC');
});

test('mark_complete: a wrapped id with no local seed reads the concept by its bare id', async () => {
  const spy = storeSpy({});
  const { client } = apiStub();
  const stub = await stubConceptDb(conceptRow('agf_remote9'));

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: WRAPPED, action: 'endorse' }),
    client,
    SESSION,
    spy.store, NO_GIT,
  );

  // The wrapped id must reach concept-db by its plain form.
  expect(out).not.toContain('is not a finding id');
  expect(stub.calls('conceptGraph')).toEqual([{ type: 'conceptGraph', concept_id: PLAIN, limit: 1 }]);
  expect(JSON.stringify(stub.pointers)).not.toContain('⟨');
  expect(out).toContain('endorsed');
});

// ── Finding 24 ──────────────────────────────────────────────────────────────

test('mark_complete: a concept carrying no agf_* id keys its verdict on the concept, never on the placeholder', async () => {
  const spy = storeSpy({});
  const { client } = apiStub();
  const stub = await stubConceptDb(conceptRow('(not cached locally)')); // record_finding's stateless placeholder

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: PLAIN, action: 'endorse' }),
    client,
    SESSION,
    spy.store, NO_GIT,
  );

  expect(stub.calls('concept_create_write')).toHaveLength(1);
  // `finding: (not cached locally)` would be one shared key every such verdict
  // collides on, joinable to nothing.
  expect(findingLine(stub)).toBe(`finding: ${PLAIN}`);
  // And the caller is told the join key is not a finding id.
  expect(out).toContain('keyed on');
});

test('mark_complete: a concept carrying a real agf_* id still keys the verdict on it, with no caveat', async () => {
  const spy = storeSpy({});
  const { client } = apiStub();
  const stub = await stubConceptDb(conceptRow('agf_remote9, agf_other'));

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: PLAIN, action: 'endorse' }),
    client,
    SESSION,
    spy.store, NO_GIT,
  );

  expect(findingLine(stub)).toBe('finding: agf_remote9');
  expect(out).not.toContain('keyed on');
});
