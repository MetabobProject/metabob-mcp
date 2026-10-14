/**
 * Concept ids are printed in one form: plain, never ⟨⟩-wrapped.
 *
 * concept-db answers some ids bare (`concept_BwUOtHpndHtA`) and others wrapped
 * (`⟨concept_AmOKMgWJ-UJM⟩`, the ones containing `-`). An agent copies what a
 * tool prints, so a wrapped id in the output becomes a wrapped id in the next
 * call. Every tool prints the plain form, and the tools that take a concept id
 * still accept the wrapped one.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';
import { setAttachment } from '../../src/attachment';
import * as RecordFinding from '../../src/tools/record-finding';
import * as MarkComplete from '../../src/tools/mark-complete';
import * as ConceptCreate from '../../src/tools/concept-create';
import * as ConceptLink from '../../src/tools/concept-link';
import * as ConceptSequence from '../../src/tools/concept-sequence';
import { installShapeStub } from '../helpers/shape-stub';

const apiClient = {} as AnalysisAPIClient;
const written = (row: Record<string, unknown>) => ({ body: { success: true, content: JSON.stringify(row) } });

let localStore: LocalStore;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `metabob-plain-id-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  localStore = new LocalStore(dbPath);
  localStore.init();
});

afterEach(() => {
  localStore.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  setAttachment(null);
});

test('record_finding prints a wrapped minted id plain, and stores it plain on the seed', async () => {
  await installShapeStub({
    concept_create_write: () => written({ id: 'concept:⟨concept_AmOK-UJM⟩', shape: 'code_finding' }),
  });
  const out = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/a.ts'], summary: 'wrapped id', severity: 'LOW', category: 'x' }),
    apiClient, 's', localStore,
  );
  expect(out).toContain('(concept concept_AmOK-UJM)');
  expect(out).not.toContain('⟨');
  expect(out).not.toContain('⟩');
  const seed = localStore.getCachedSeeds('src/a.ts')[0]!;
  expect(seed.refs_json).toBe(JSON.stringify(['concept:concept_AmOK-UJM']));
});

test('mark_complete accepts a wrapped id and prints it plain, with a plain verdict id', async () => {
  await installShapeStub({
    concept_create_write: (p) => written({
      id: p.conceptData?.shape === 'finding_verdict' ? '⟨concept_ver-dict⟩' : 'concept:⟨concept_fin-ding⟩',
    }),
    conceptUsage_write: () => written({ id: 'usage_1', outcome: 'success' }),
  });
  await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/b.ts'], summary: 'to close', severity: 'LOW', category: 'x' }),
    apiClient, 's', localStore,
  );
  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: '⟨concept_fin-ding⟩', action: 'endorse' }),
    apiClient, 's', localStore,
  );
  expect(out).toContain('(via concept_fin-ding)');
  expect(out).toContain('concept concept_ver-dict');
  expect(out).not.toMatch(/[⟨⟩]/);
});

test('concept_create, concept_link and concept_sequence print plain ids', async () => {
  await installShapeStub({
    concept_create_write: () => written({ id: '⟨concept:concept_cr-1⟩', shape: 'note', source_type: 'x' }),
    conceptLink_write: () => written({ id: 'concept_edge:⟨e-1⟩', created: true, new_weight: 1 }),
    conceptSequence: () => ({ body: { content: [{ concept_id: 'concept:⟨concept_nx-1⟩', weight: 0.5, times_traversed: 2 }] } }),
  });
  const created = await ConceptCreate.handle(
    ConceptCreate.InputSchema.parse({ content: 'c', shape: 'note', source_type: 'memo' }),
    apiClient,
  );
  expect(created).toContain('id:          concept_cr-1');

  const linked = await ConceptLink.handle(
    ConceptLink.InputSchema.parse({ from_concept_id: '⟨concept_a-1⟩', to_concept_id: 'concept_b', edge_type: 'related_to' }),
    apiClient,
  );
  expect(linked).toContain('id:          e-1');
  expect(linked).toContain('from:        concept_a-1');

  const seq = await ConceptSequence.handle(
    ConceptSequence.InputSchema.parse({ concept_id: '⟨concept_a-1⟩' }),
    apiClient,
  );
  expect(seq).toContain('of concept_a-1');
  expect(seq).toContain('concept_nx-1');

  for (const out of [created, linked, seq]) expect(out).not.toMatch(/[⟨⟩]/);
});
