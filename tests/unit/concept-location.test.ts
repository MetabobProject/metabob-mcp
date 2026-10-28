/**
 * concept_create writes where a memo concept applies as header lines, the way code_finding carries them
 * (SPEC §concept_create): a reader such as the dashboard places a decision, handoff or run report by its
 * repo:, files: and subject: lines, never by prose.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';
import { setAttachment } from '../../src/attachment';
import { setResolverIdentity } from '../../src/resolver-identity';
import * as ConceptCreate from '../../src/tools/concept-create';
import { installShapeStub } from '../helpers/shape-stub';

beforeAll(() => setResolverIdentity({ vesselId: 'metabob-mcp-writer' }));
afterAll(() => setResolverIdentity({ vesselId: undefined }));
afterEach(() => setAttachment(null));

const repo = { id: 'github.com/acme/app', name: 'app' } as never;

test('a memo shape gets the repo lines; files and subject come from the inputs', () => {
  expect(ConceptCreate.locationLines('decision_record', repo, ['/w/src/a.ts', 'b.ts'], undefined, '/w')).toEqual([
    'repo: github.com/acme/app', 'repo_name: app', 'files: src/a.ts, b.ts',
  ]);
  expect(ConceptCreate.locationLines('run_report', repo, undefined, ' issue\n#12 ', '/w')).toEqual([
    'repo: github.com/acme/app', 'repo_name: app', 'subject: issue #12',
  ]);
  // Another shape carries only what it was given, and no repository resolves to no repo line.
  expect(ConceptCreate.locationLines('repo_anchor', repo, undefined, undefined, '/w')).toEqual([]);
  expect(ConceptCreate.locationLines('task_handoff', null, ['a.ts'], undefined, '/w')).toEqual(['files: a.ts']);
});

test('the tool\'s location lines follow the author stamp and replace the agent\'s lines of the same key', () => {
  const r = ConceptCreate.stampAuthor('repo: guessed\nfiles: x.ts\nkind: decision\n\nrepo: in the body', 'metabob-mcp-writer', 's1',
    ['repo: github.com/acme/app', 'repo_name: app']);
  expect(r.content).toBe('recorded_by: metabob-mcp-writer\nsession: s1\nrepo: github.com/acme/app\nrepo_name: app\nfiles: x.ts\nkind: decision\n\nrepo: in the body');
  expect(r.replaced).toEqual(['repo: guessed']);
});

test('concept_create sends the location header and reports it', async () => {
  const stub = await installShapeStub({
    concept_create_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'concept_n2', shape: 'task_handoff', source_type: 'memo' }) } }),
  });
  const out = await ConceptCreate.handle(
    ConceptCreate.InputSchema.parse({ content: 'Task: agf_x\nDone: nothing', shape: 'task_handoff', source_type: 'memo', subject: 'the release check' }),
    {} as AnalysisAPIClient, 'sess-1',
  );
  const sent = String(stub.calls('concept_create_write')[0]!.conceptData.content).split('\n');
  expect(sent.slice(0, 2)).toEqual(['recorded_by: metabob-mcp-writer', 'session: sess-1']);
  expect(sent).toContain('subject: the release check');
  expect(sent.some((l) => l.startsWith('repo: '))).toBe(true);
  expect(out).toContain('location:    repo: ');
});
