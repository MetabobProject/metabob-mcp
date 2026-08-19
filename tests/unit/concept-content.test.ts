/**
 * Unit tests for the concept BODY rendering added to concept_search and
 * concept_neighbors.
 *
 * The defect these cover: both tools rendered id/shape/summary/metrics and
 * never the content, so an agent could see that a decision had been recorded
 * but not read it. These assert the body is rendered by DEFAULT (an opt-in flag
 * would reproduce the defect), that truncation is disclosed with the full
 * length, and that both structured `key: value` lines and prose survive.
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';

import * as ConceptSearch from '../../src/tools/concept-search';
import * as ConceptNeighbors from '../../src/tools/concept-neighbors';
import { truncateBody, renderConceptContent, PREVIEW_CHAR_BUDGET } from '../../src/tools/_concept-content';

let mockApiClient: AnalysisAPIClient;
let savedConceptDbUrl: string | undefined;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

/** A body with structured lines first, then prose, then more structured lines. */
const STRUCTURED_AND_PROSE = [
  'repo: metabob-dashboard',
  'files: src/db/migrate.ts',
  'recorded_by: metabob-mcp-abc123def456',
  '',
  'The migration runner must apply every pending migration inside a single',
  'transaction. An earlier attempt applied them one-per-transaction, which left',
  'the schema half-migrated when step four failed and there was no way to tell',
  'from the schema_version row which steps had actually run.',
  '',
  'decision: single transaction, rollback the whole batch on any failure.',
  'finding_ids: agf_9f8e7d6c5b4a',
].join('\n');

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    isVesselMode: mock(() => false),
    hasDiscovery: mock(() => false),
    getDiscoveryEndpoint: mock(() => undefined),
  } as unknown as AnalysisAPIClient;
  savedConceptDbUrl = process.env.CONCEPT_DB_URL;
});

afterEach(() => {
  if (savedConceptDbUrl === undefined) delete process.env.CONCEPT_DB_URL;
  else process.env.CONCEPT_DB_URL = savedConceptDbUrl;
  for (const s of servers.splice(0)) s.stop(true);
});

/** Stand up a concept-db stub and point CONCEPT_DB_URL at it. */
function serveConceptDb(handler: (req: Request, url: URL) => Response | Promise<Response>): void {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      return handler(req, new URL(req.url));
    },
  });
  servers.push(server);
  process.env.CONCEPT_DB_URL = `http://127.0.0.1:${server.port}`;
}

// ===== the truncation primitive =====

test('truncateBody returns the body verbatim when it fits the budget', () => {
  expect(truncateBody('short body', 100)).toBe('short body');
});

test('truncateBody backs off to the last newline so a structured line is never half-shown', () => {
  const body = 'repo: dashboard\nfiles: a.ts, b.ts, c.ts, d.ts\nprose follows here';
  const cut = truncateBody(body, 30);
  // 30 chars would land inside the files: list; the cut must not show a shorter,
  // different list.
  expect(cut).toBe('repo: dashboard');
  expect(body.startsWith(cut)).toBe(true);
});

test('truncateBody hard-cuts when the first line alone exceeds the budget', () => {
  const body = `${'x'.repeat(200)}\nsecond line`;
  expect(truncateBody(body, 50)).toBe('x'.repeat(50));
});

test('renderConceptContent discloses the truncation with the full length', () => {
  const body = 'a'.repeat(2000);
  const out = renderConceptContent(body, 'preview', { conceptId: 'cf_probe1' });
  expect(out).toContain('[content truncated: showing 700 of 2000 chars');
  expect(out).toContain('concept_id="cf_probe1"');
});

test('renderConceptContent adds no truncation noise when the whole body is shown', () => {
  const out = renderConceptContent('a short recorded decision', 'preview', { conceptId: 'c1' });
  expect(out).toContain('a short recorded decision');
  expect(out).not.toContain('truncated');
});

test("renderConceptContent mode 'none' omits the body entirely", () => {
  expect(renderConceptContent(STRUCTURED_AND_PROSE, 'none', {})).toBe('');
});

test("renderConceptContent mode 'full' emits the whole body and no disclosure", () => {
  const body = `${'a'.repeat(PREVIEW_CHAR_BUDGET + 500)}\ntail line`;
  const out = renderConceptContent(body, 'full', { conceptId: 'c1' });
  expect(out).toContain('tail line');
  expect(out).not.toContain('truncated');
});

// ===== concept_search =====

test('concept_search renders the concept body by default', async () => {
  serveConceptDb((_req, url) =>
    url.pathname === '/concepts/search'
      ? Response.json({
          concepts: [
            {
              id: 'concept:cd_migrate1',
              source_type: 'human_input',
              shape: 'design_constraint',
              summary: 'migrations run in one transaction',
              content: STRUCTURED_AND_PROSE,
              relevance: 0.62,
              updated_at: '2026-08-19T00:00:00Z',
            },
          ],
          count: 1,
        })
      : new Response('not found', { status: 404 }),
  );

  const out = await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ shape: 'design_constraint' }),
    mockApiClient,
  );

  // structured key: value lines survive
  expect(out).toContain('repo: metabob-dashboard');
  expect(out).toContain('finding_ids: agf_9f8e7d6c5b4a');
  // prose survives
  expect(out).toContain('rollback the whole batch on any failure');
  expect(out).toContain('single');
  // and the old fields are still there
  expect(out).toContain('cd_migrate1');
  expect(out).toContain('summary:  migrations run in one transaction');
});

test('concept_search discloses truncation of a long body and names the escape hatch', async () => {
  const long = `${STRUCTURED_AND_PROSE}\n${'filler prose line.\n'.repeat(120)}`;
  serveConceptDb((_req, url) =>
    url.pathname === '/concepts/search'
      ? Response.json({ concepts: [{ id: 'concept:cd_long1', shape: 'gotcha', content: long }] })
      : new Response('not found', { status: 404 }),
  );

  const out = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({}), mockApiClient);

  expect(out).toContain(`of ${long.length} chars`);
  expect(out).toContain('[content truncated: showing');
  expect(out).toContain('content="full"');
  expect(out).toContain('concept_id="cd_long1"');
});

test("concept_search content:'none' suppresses the body", async () => {
  serveConceptDb((_req, url) =>
    url.pathname === '/concepts/search'
      ? Response.json({ concepts: [{ id: 'concept:cd_x', shape: 'gotcha', content: STRUCTURED_AND_PROSE }] })
      : new Response('not found', { status: 404 }),
  );
  const out = await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ content: 'none' }),
    mockApiClient,
  );
  expect(out).toContain('cd_x');
  expect(out).not.toContain('repo: metabob-dashboard');
});

test('concept_search concept_id does a direct read and returns the whole body untruncated', async () => {
  const long = `${STRUCTURED_AND_PROSE}\n${'filler prose line.\n'.repeat(120)}`;
  let searchCalls = 0;
  let readPath = '';
  serveConceptDb((_req, url) => {
    if (url.pathname === '/concepts/search') {
      searchCalls++;
      return Response.json({ concepts: [] });
    }
    if (url.pathname.startsWith('/concepts/')) {
      readPath = url.pathname;
      return Response.json({ id: 'concept:cd_long1', shape: 'gotcha', content: long });
    }
    return new Response('not found', { status: 404 });
  });

  const out = await ConceptSearch.handle(
    // A `concept:⟨…⟩`-wrapped id must normalise, the way mark_complete's read does.
    ConceptSearch.InputSchema.parse({ concept_id: 'concept:⟨cd_long1⟩' }),
    mockApiClient,
  );

  expect(readPath).toBe('/concepts/cd_long1');
  expect(searchCalls).toBe(0);
  expect(out).toContain('direct read by id');
  expect(out).toContain('filler prose line.');
  expect(out).not.toContain('truncated');
});

test('concept_search concept_id reports a missing concept as a 404, not as an empty search', async () => {
  serveConceptDb(() => new Response('no such concept', { status: 404 }));
  const out = await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ concept_id: 'cd_nope' }),
    mockApiClient,
  );
  expect(out).toContain('No concept cd_nope (404 from concept-db)');
});

test('concept_search still sends an empty query in list mode and passes the shape filter through', async () => {
  let seen = '';
  serveConceptDb((_req, url) => {
    seen = url.search;
    return Response.json({ concepts: [] });
  });
  await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ shape: 'code_finding', limit: 5 }),
    mockApiClient,
  );
  // list mode: NO query param at all (concept-db 0.3.0 needs it empty/absent);
  // and `content` must never leak into the upstream request.
  expect(seen).not.toContain('query=');
  expect(seen).toContain('shape=code_finding');
  expect(seen).toContain('limit=5');
  expect(seen).not.toContain('content=');
});

test('concept_search strips the ⟨⟩ id decoration so the escape hatch is pasteable', async () => {
  // Measured live on dashboard-film: one search response carried both a bare id
  // and a ⟨…⟩-wrapped one. The wrapped form must not be what the tool tells the
  // agent to paste back as concept_id.
  const long = 'a'.repeat(1500);
  serveConceptDb((_req, url) =>
    url.pathname === '/concepts/search'
      ? Response.json({ concepts: [{ id: 'concept:⟨cd_wrapped1⟩', shape: 'gotcha', content: long }] })
      : new Response('not found', { status: 404 }),
  );
  const out = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({}), mockApiClient);
  expect(out).toContain('id:       cd_wrapped1');
  expect(out).toContain('concept_id="cd_wrapped1"');
  expect(out).not.toContain('⟨');
});

// ===== concept_neighbors =====

test('concept_neighbors renders the neighbour body by default', async () => {
  serveConceptDb((_req, url) =>
    url.pathname.endsWith('/neighbors')
      ? Response.json({
          neighbors: [
            {
              concept: {
                id: 'concept:cd_migrate1',
                shape: 'design_constraint',
                summary: 'migrations run in one transaction',
                content: STRUCTURED_AND_PROSE,
                relevance: 0.5,
              },
              edge: { edge_type: 'related_to', weight: 0.9, times_traversed: 2 },
            },
          ],
        })
      : new Response('not found', { status: 404 }),
  );

  const out = await ConceptNeighbors.handle(
    ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_seed1' }),
    mockApiClient,
  );

  expect(out).toContain('repo: metabob-dashboard');
  expect(out).toContain('rollback the whole batch on any failure');
  expect(out).toContain('[related_to]');
});

test('concept_neighbors discloses truncation and points at concept_search for the full body', async () => {
  const long = `${STRUCTURED_AND_PROSE}\n${'filler prose line.\n'.repeat(120)}`;
  serveConceptDb((_req, url) =>
    url.pathname.endsWith('/neighbors')
      ? Response.json({
          neighbors: [
            { concept: { id: 'concept:cd_long1', shape: 'gotcha', content: long }, edge: { edge_type: 'derived_from' } },
          ],
        })
      : new Response('not found', { status: 404 }),
  );

  const out = await ConceptNeighbors.handle(
    ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_seed1' }),
    mockApiClient,
  );

  expect(out).toContain(`of ${long.length} chars`);
  expect(out).toContain('concept_search concept_id="cd_long1"');
});

test("concept_neighbors content:'none' suppresses the neighbour body", async () => {
  serveConceptDb((_req, url) =>
    url.pathname.endsWith('/neighbors')
      ? Response.json({
          neighbors: [
            { concept: { id: 'concept:cd_x', shape: 'gotcha', content: STRUCTURED_AND_PROSE }, edge: {} },
          ],
        })
      : new Response('not found', { status: 404 }),
  );
  const out = await ConceptNeighbors.handle(
    ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_seed1', content: 'none' }),
    mockApiClient,
  );
  expect(out).toContain('cd_x');
  expect(out).not.toContain('repo: metabob-dashboard');
});
