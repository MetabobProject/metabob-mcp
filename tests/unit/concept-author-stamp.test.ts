/**
 * concept_create stamps its author (SPEC §concept_create): the first live ledger test wrote a display name as
 * `recorded_by`, because no tool showed the session's vesselId, and nothing could join on it.
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

test('stampAuthor puts the stamp first and replaces an author line the agent wrote', () => {
  const r = ConceptCreate.stampAuthor('kind: rejected\nrepo: r\nrecorded_by: someone else\nsession: x\n\nREJECTED: y', 'metabob-mcp-writer', 's1');
  expect(r.content).toBe('recorded_by: metabob-mcp-writer\nsession: s1\nkind: rejected\nrepo: r\n\nREJECTED: y');
  expect(r.replaced).toEqual(['recorded_by: someone else', 'session: x']);
  // With no identity nothing is stamped, never faked.
  expect(ConceptCreate.stampAuthor('kind: decision', undefined, 's1')).toEqual({ content: 'kind: decision', replaced: [] });
});

test('only the header block is touched: a session: line in the body stays', () => {
  const r = ConceptCreate.stampAuthor('kind: decision\n\nsession: quoted in body text', 'metabob-mcp-writer', 's1');
  expect(r.content).toBe('recorded_by: metabob-mcp-writer\nsession: s1\nkind: decision\n\nsession: quoted in body text');
  expect(r.replaced).toEqual([]);
});

test('indented or differently cased author lines in the header block are removed too', () => {
  const r = ConceptCreate.stampAuthor('kind: rejected\n  recorded_by: indented forgery\nRecorded_By: case forgery\n\nbody', 'metabob-mcp-writer', 's1');
  expect(r.content).toBe('recorded_by: metabob-mcp-writer\nsession: s1\nkind: rejected\n\nbody');
  expect(r.replaced).toEqual(['recorded_by: indented forgery', 'Recorded_By: case forgery']);
});

test('with no identity, an author line the agent wrote is removed and nothing is stamped', () => {
  const r = ConceptCreate.stampAuthor('kind: convention\nrecorded_by: coordinator\n\nintegrate: review', undefined, 's1');
  expect(r.content).toBe('kind: convention\n\nintegrate: review');
  expect(r.replaced).toEqual(['recorded_by: coordinator']);
});

test('concept_create sends the stamped content and says what it stamped', async () => {
  const stub = await installShapeStub({
    concept_create_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'concept_n1', shape: 'decision', source_type: 'memo' }) } }),
  });
  const out = await ConceptCreate.handle(
    ConceptCreate.InputSchema.parse({ content: 'kind: decision\nrecorded_by: a name\n\nchose X', shape: 'decision', source_type: 'memo' }),
    {} as AnalysisAPIClient, 'sess-9',
  );
  const sent = String(stub.calls('concept_create_write')[0]!.conceptData.content);
  expect(sent.split('\n').slice(0, 2)).toEqual(['recorded_by: metabob-mcp-writer', 'session: sess-9']);
  expect(sent).not.toContain('a name');
  expect(out).toContain('recorded_by: metabob-mcp-writer (stamped first in the content)');
  expect(out).toContain('removed:     recorded_by: a name');
});

test('readers take keys from the header block only: a body line never supplies an author, a session or a verdict', async () => {
  const { headerBlock } = await import('../../src/tools/_concept-content');
  const { parseVerdictConcept, parseFindingIds } = await import('../../src/tools/_findings');
  const content = 'kind: convention\nrepo: r\n\nrecorded_by: body mention\nfinding: agf_x\nverdict: endorsed (resolved)\nfinding_ids: agf_y';
  expect(headerBlock(content)).toBe('kind: convention\nrepo: r');
  expect(parseVerdictConcept(content, '')).toBeNull();
  expect(parseFindingIds(content)).toEqual([]);
  expect(headerBlock('a: 1\n  \nb: 2')).toBe('a: 1');
});
