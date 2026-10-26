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
import { NO_PRODUCER_MEANING, setAttachment } from '../../src/attachment';
import { installShapeStub } from '../helpers/shape-stub';

let mockApiClient: AnalysisAPIClient;

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
  mockApiClient = { get: mock(async () => ({})) } as unknown as AnalysisAPIClient;
});

// concept-db is reached through the attachment's one ingress (discovery POST /resolve).
afterEach(() => setAttachment(null));

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

/** concept-db's conceptSearch answer for these rows. */
const searchAnswer = (rows: unknown[]) => ({ body: { content: rows, metadata: { shape: 'conceptSearch', count: rows.length } } });

/** concept-db's conceptGraph answer: the root row and its edges. */
const graphAnswer = (root: unknown, edges: unknown[] = []) => ({ body: { content: { root, edges }, metadata: { shape: 'conceptGraph' } } });

test('concept_search renders the concept body by default', async () => {
  await installShapeStub({
    conceptSearch: () => searchAnswer([
      {
        id: 'concept:cd_migrate1',
        source_type: 'human_input',
        shape: 'design_constraint',
        summary: 'migrations run in one transaction',
        content: STRUCTURED_AND_PROSE,
        relevance: 0.62,
        updated_at: '2026-08-19T00:00:00Z',
      },
    ]),
  });

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

test('a query result says it is the nearest matches, not every one, and how to list them all', async () => {
  const rows = [1, 2, 3, 4].map((n) => ({ id: `concept:pc_${n}`, shape: 'project_convention', content: `kind: policy\nrule ${n}` }));
  await installShapeStub({ conceptSearch: () => searchAnswer(rows) });
  const ranked = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({ shape: 'project_convention', query: 'csv', limit: 50 }), mockApiClient);
  expect(ranked).toContain('Ranked by similarity to the query: the nearest 4 of those that match the filters (limit 50), not every one.');
  expect(ranked).toContain('call with shape and no query (shape: "project_convention")');
  const listed = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({ shape: 'project_convention', limit: 4 }), mockApiClient);
  expect(listed).not.toContain('Ranked by similarity');
  expect(listed).toContain('The limit (4) was reached, so more may match: the next page is offset: 4');
  const under = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({ shape: 'project_convention', limit: 50 }), mockApiClient);
  expect(under).not.toContain('limit');
});

test('an offset a concept-db does not page says so, rather than passing the first page off as the next', async () => {
  const rows = [1, 2].map((n) => ({ id: `concept:pc_${n}`, shape: 'project_convention', content: `rule ${n}` }));
  // Ignores the offset, and the rows come back reordered: still the first page.
  await installShapeStub({ conceptSearch: (p) => searchAnswer(p.offset ? [...rows].reverse() : rows) });
  const out = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({ shape: 'project_convention', limit: 2, offset: 2 }), mockApiClient);
  expect(out).toContain('concept-db does not page: offset 2 answered the first page again, so at most 2 concepts of shape "project_convention" can be read');
  expect(out).not.toContain('pc_1');
});

test('an offset a concept-db pages returns the next page', async () => {
  const page = (offset: number) => [1, 2].map((n) => ({ id: `concept:pc_${offset + n}`, shape: 'project_convention', content: `rule ${offset + n}` }));
  await installShapeStub({ conceptSearch: (p) => searchAnswer(page(Number(p.offset ?? 0))) });
  const out = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({ shape: 'project_convention', limit: 2, offset: 2 }), mockApiClient);
  expect(out).toContain('pc_3');
  expect(out).not.toContain('does not page');
});

test('concept_search discloses truncation of a long body and names the escape hatch', async () => {
  const long = `${STRUCTURED_AND_PROSE}\n${'filler prose line.\n'.repeat(120)}`;
  await installShapeStub({ conceptSearch: () => searchAnswer([{ id: 'concept:cd_long1', shape: 'gotcha', content: long }]) });

  const out = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({}), mockApiClient);

  expect(out).toContain(`of ${long.length} chars`);
  expect(out).toContain('[content truncated: showing');
  expect(out).toContain('content="full"');
  expect(out).toContain('concept_id="cd_long1"');
});

test("concept_search content:'none' suppresses the body", async () => {
  await installShapeStub({ conceptSearch: () => searchAnswer([{ id: 'concept:cd_x', shape: 'gotcha', content: STRUCTURED_AND_PROSE }]) });
  const out = await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ content: 'none' }),
    mockApiClient,
  );
  expect(out).toContain('cd_x');
  expect(out).not.toContain('repo: metabob-dashboard');
});

test('concept_search concept_id does a direct read and returns the whole body untruncated', async () => {
  const long = `${STRUCTURED_AND_PROSE}\n${'filler prose line.\n'.repeat(120)}`;
  const stub = await installShapeStub({
    conceptSearch: () => searchAnswer([]),
    conceptGraph: () => graphAnswer({ id: 'concept:cd_long1', shape: 'gotcha', content: long }),
  });

  const out = await ConceptSearch.handle(
    // A `concept:⟨…⟩`-wrapped id must normalise, the way mark_complete's read does.
    ConceptSearch.InputSchema.parse({ concept_id: 'concept:⟨cd_long1⟩' }),
    mockApiClient,
  );

  expect(stub.calls('conceptGraph')).toEqual([{ type: 'conceptGraph', concept_id: 'cd_long1', limit: 1 }]);
  expect(stub.calls('conceptSearch')).toEqual([]);
  expect(out).toContain('direct read by id');
  expect(out).toContain('filler prose line.');
  expect(out).not.toContain('truncated');
});

test('concept_search concept_id reports a missing concept as a 404, not as an empty search', async () => {
  await installShapeStub({ conceptGraph: (p) => ({ status: 404, body: { error: `Concept not found: ${p.concept_id}` } }) });
  const out = await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ concept_id: 'cd_nope' }),
    mockApiClient,
  );
  expect(out).toContain('No concept cd_nope (404 from concept-db)');
});

test('concept_search still sends an empty query in list mode and passes the shape filter through', async () => {
  const stub = await installShapeStub({ conceptSearch: () => searchAnswer([]) });
  await ConceptSearch.handle(
    ConceptSearch.InputSchema.parse({ shape: 'code_finding', limit: 5 }),
    mockApiClient,
  );
  // list mode: NO query at all (concept-db needs it empty/absent);
  // and `content` must never leak into the upstream request.
  expect(stub.calls('conceptSearch')).toEqual([{ type: 'conceptSearch', shape: 'code_finding', limit: 5 }]);
});

test('concept_search strips the ⟨⟩ id decoration so the escape hatch is pasteable', async () => {
  // One search response can carry both a bare id and a ⟨…⟩-wrapped one. The wrapped form must not be what the tool tells the
  // agent to paste back as concept_id.
  const long = 'a'.repeat(1500);
  await installShapeStub({ conceptSearch: () => searchAnswer([{ id: 'concept:⟨cd_wrapped1⟩', shape: 'gotcha', content: long }]) });
  const out = await ConceptSearch.handle(ConceptSearch.InputSchema.parse({}), mockApiClient);
  expect(out).toContain('id:       cd_wrapped1');
  expect(out).toContain('concept_id="cd_wrapped1"');
  expect(out).not.toContain('⟨');
});

test('concept_search names a discovery failure in one line', async () => {
  await installShapeStub({});
  expect(await ConceptSearch.handle(ConceptSearch.InputSchema.parse({}), mockApiClient)).toBe(
    `concept_search: no_producer(conceptSearch): ${NO_PRODUCER_MEANING}`,
  );
});

// ===== concept_neighbors =====

test('concept_neighbors renders the neighbour body by default', async () => {
  const stub = await installShapeStub({
    conceptGraph: () => graphAnswer({ id: 'concept:cd_seed1' }, [
      {
        neighbor: {
          id: 'concept:cd_migrate1',
          shape: 'design_constraint',
          summary: 'migrations run in one transaction',
          content: STRUCTURED_AND_PROSE,
          relevance: 0.5,
        },
        edge: { edge_type: 'related_to', weight: 0.9, times_traversed: 2 },
      },
    ]),
  });

  const out = await ConceptNeighbors.handle(
    ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_seed1' }),
    mockApiClient,
  );

  expect(stub.calls('conceptGraph')).toEqual([{ type: 'conceptGraph', concept_id: 'cd_seed1', direction: 'both', limit: 10 }]);
  expect(out).toContain('repo: metabob-dashboard');
  expect(out).toContain('rollback the whole batch on any failure');
  expect(out).toContain('[related_to]');
  expect(out).toContain('edge:     weight=0.90  traversed=2');
});

test('concept_neighbors discloses truncation and points at concept_search for the full body', async () => {
  const long = `${STRUCTURED_AND_PROSE}\n${'filler prose line.\n'.repeat(120)}`;
  await installShapeStub({
    conceptGraph: () => graphAnswer({ id: 'concept:cd_seed1' }, [
      { neighbor: { id: 'concept:cd_long1', shape: 'gotcha', content: long }, edge: { edge_type: 'derived_from' } },
    ]),
  });

  const out = await ConceptNeighbors.handle(
    ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_seed1' }),
    mockApiClient,
  );

  expect(out).toContain(`of ${long.length} chars`);
  expect(out).toContain('concept_search concept_id="cd_long1"');
});

test("concept_neighbors content:'none' suppresses the neighbour body", async () => {
  await installShapeStub({
    conceptGraph: () => graphAnswer({ id: 'concept:cd_seed1' }, [
      { neighbor: { id: 'concept:cd_x', shape: 'gotcha', content: STRUCTURED_AND_PROSE }, edge: {} },
    ]),
  });
  const out = await ConceptNeighbors.handle(
    ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_seed1', content: 'none' }),
    mockApiClient,
  );
  expect(out).toContain('cd_x');
  expect(out).not.toContain('repo: metabob-dashboard');
});

test('concept_neighbors of an unknown concept (concept-db 404) has no neighbours', async () => {
  await installShapeStub({ conceptGraph: (p) => ({ status: 404, body: { error: `Concept not found: ${p.concept_id}` } }) });
  const out = await ConceptNeighbors.handle(ConceptNeighbors.InputSchema.parse({ concept_id: 'cd_nope' }), mockApiClient);
  expect(out).toStartWith('No neighbors for concept cd_nope (direction=both).');
});