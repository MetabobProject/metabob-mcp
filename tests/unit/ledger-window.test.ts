/**
 * The ledger past one read's window (SPEC §get_problems): concept-db's list mode answers at most FINDINGS_MAX_SCAN
 * rows a page, by relevance then newest, so verdicts and claims outgrow it first. A finding's verdicts are linked to it
 * (verdict --derived_from--> finding) and read through conceptGraph when the verdict scan is truncated, and a scan
 * pages by offset when concept-db honours it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { setAttachment } from '../../src/attachment';
import { fetchAgentFindings, resetOffsetProbeForTests } from '../../src/tools/_findings';
import { installShapeStub } from '../helpers/shape-stub';

const REPO = 'github.com/o/r';
afterEach(() => {
  setAttachment(null);
  resetOffsetProbeForTests();
});

const finding = (n: string) => ({
  id: `concept:concept_${n}`, shape: 'code_finding', summary: `[MEDIUM][correctness] r: finding ${n}`, created_at: new Date(Date.now() - 3_600_000).toISOString(),
  content: `repo: ${REPO}\nfiles: src/${n}.ts\ncategory: correctness\nfinding_ids: agf_${n}`,
});
const verdict = (id: string, agf: string, body: string) => ({
  id: `concept:${id}`, shape: 'finding_verdict', summary: '[verdict:resolved] r: x', created_at: new Date().toISOString(),
  content: `finding: ${agf}\n${body}\nrepo: ${REPO}`,
});
/** 300 verdicts on other findings: a full page, so the scan reads as truncated. */
const noise = Array.from({ length: 300 }, (_, i) => verdict(`concept_noise${i}`, `agf_other${i}`, 'verdict: endorsed (resolved)'));

describe('verdicts outside the scan window', () => {
  test('a truncated verdict scan reads each finding\'s linked verdicts: the endorse outside it closes the finding', async () => {
    const stub = await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [finding('a'), finding('b')] : noise } }),
      conceptGraph: (p) => ({
        body: { content: { root: {}, edges: p.concept_id === 'concept_a' ? [{ edge: { edge_type: 'derived_from' }, neighbor: verdict('concept_va', 'agf_a', 'verdict: endorsed (resolved)\nfix: commit abc') }] : [] } },
      }),
    });
    const r = await fetchAgentFindings({} as never, { repo: REPO, aliases: null });
    const byId = new Map(r.findings.map(f => [f.id, f]));
    expect(byId.get('concept_a')!.verdict).toBe('fixed');
    expect(byId.get('concept_b')!.verdict).toBeUndefined();
    const graphs = stub.calls('conceptGraph');
    expect(graphs.map(g => g.concept_id).sort()).toEqual(['concept_a', 'concept_b']);
    expect(graphs[0]).toMatchObject({ direction: 'incoming', edge_types: ['derived_from'] });
  });

  test('a claim outside the window still names its holder', async () => {
    const claim = {
      ...verdict('concept_ca', 'agf_a', `verdict: claimed\nclaim_minutes: 60\nreviewed_by: metabob-mcp-other`),
      summary: '[verdict:claimed] r: x', created_at: new Date(Date.now() - 60_000).toISOString(),
    };
    await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [finding('a')] : noise } }),
      conceptGraph: () => ({ body: { content: { root: {}, edges: [{ edge: {}, neighbor: claim }] } } }),
    });
    const r = await fetchAgentFindings({} as never, { repo: REPO, aliases: null });
    expect(r.findings[0]!.claim).toMatchObject({ by: 'metabob-mcp-other' });
  });

  test('a scan that is not truncated reads no graph', async () => {
    const stub = await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [finding('a')] : [verdict('concept_va', 'agf_a', 'verdict: endorsed (resolved)')] } }),
      conceptGraph: () => ({ body: { content: { root: {}, edges: [] } } }),
    });
    const r = await fetchAgentFindings({} as never, { repo: REPO, aliases: null });
    expect(r.findings[0]!.verdict).toBe('fixed');
    expect(stub.calls('conceptGraph')).toHaveLength(0);
  });
});

describe('paging', () => {
  test('a full page asks for the next by offset; the verdict on page two closes the finding', async () => {
    const page2 = [verdict('concept_va', 'agf_a', 'verdict: endorsed (resolved)')];
    const stub = await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [finding('a')] : (p.offset ? page2 : noise) } }),
      conceptGraph: () => ({ body: { content: { root: {}, edges: [] } } }),
    });
    const r = await fetchAgentFindings({} as never, { repo: REPO, aliases: null });
    expect(r.findings[0]!.verdict).toBe('fixed');
    expect(stub.calls('conceptSearch').filter(p => p.shape === 'finding_verdict').map(p => p.offset ?? 0)).toEqual([0, 300]);
  });

  test('a concept-db that ignores the offset answers page one again: the scan stops, and later scans read one page', async () => {
    const stub = await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [finding('a')] : noise } }),
      conceptGraph: () => ({ body: { content: { root: {}, edges: [] } } }),
    });
    await fetchAgentFindings({} as never, { repo: REPO, aliases: null });
    expect(stub.calls('conceptSearch').filter(p => p.shape === 'finding_verdict')).toHaveLength(2);
    await fetchAgentFindings({} as never, { repo: REPO, aliases: null });
    expect(stub.calls('conceptSearch').filter(p => p.shape === 'finding_verdict')).toHaveLength(3);
  });
});

describe('every verdict is linked to its finding', () => {
  test('mark_complete from a recalled concept, and a claim, each link verdict --derived_from--> finding', async () => {
    const MarkComplete = await import('../../src/tools/mark-complete');
    const Claim = await import('../../src/tools/claim-finding');
    const { setResolverIdentity } = await import('../../src/resolver-identity');
    setResolverIdentity({ vesselId: 'metabob-mcp-me' });
    let n = 0;
    const rows: Array<Record<string, unknown>> = [finding('a')];
    const stub = await installShapeStub({
      conceptGraph: (p) => (p.concept_id === 'concept_a' ? { body: { content: { root: finding('a'), edges: [] } } } : { status: 404, body: { error: 'Concept not found' } }),
      conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape) } }),
      concept_create_write: (p) => {
        const id = `concept_v${++n}`;
        rows.push({ id: `concept:${id}`, shape: p.conceptData.shape, summary: p.conceptData.summary, content: p.conceptData.content, created_at: new Date().toISOString() });
        return { body: { success: true, content: JSON.stringify({ id }) } };
      },
      conceptLink_write: () => ({ body: { success: true, content: '{}' } }),
      conceptUsage_write: () => ({ body: { success: true, content: '{}' } }),
    });
    await Claim.claim(Claim.InputSchema.parse({ problem_id: 'concept_a', action: 'claim' }), 's', null, { repo: null, pauses: [0] });
    await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'concept_a', action: 'discard' }), {} as never, 's', null);
    const links = stub.calls('conceptLink_write').map(p => p.linkData);
    expect(links).toEqual([
      expect.objectContaining({ from_concept_id: 'concept_v1', to_concept_id: 'concept_a', edge_type: 'derived_from' }),
      expect.objectContaining({ from_concept_id: 'concept_v2', to_concept_id: 'concept_a', edge_type: 'derived_from' }),
    ]);
    setResolverIdentity({ vesselId: undefined });
  });
});
