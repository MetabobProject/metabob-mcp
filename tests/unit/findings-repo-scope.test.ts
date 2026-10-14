/**
 * Recall scoping for cross-agent findings.
 *
 * The sidecar's concept-db corpus is shared across every repository an org's
 * agents work in, so `fetchAgentFindings` must answer "which of these findings
 * are about MY repository". It previously substring-matched the repo name over
 * the whole concept body — and every finding carries `recorded_by:
 * metabob-mcp-<hash>`, whose vessel id embeds this package's own name. Against
 * a live corpus that scored 47 matches for 5 genuine ones (10.6% precision):
 * findings about a Python library were recalled as if they were about this repo.
 */
import { describe, expect, test } from 'bun:test';
import { fetchAgentFindings } from '../../src/tools/_findings.js';
import { setAttachment } from '../../src/attachment';
import { installShapeStub } from '../helpers/shape-stub';

type Row = { id: string; summary: string; content: string };

/** A concept-db row in the shape record_finding mints. */
function finding(id: string, repo: string, files: string, body = 'detail'): Row {
  return {
    id: `concept:${id}`,
    summary: `[HIGH][correctness] ${repo}: ${body}`,
    content: [
      `repo: ${repo}`,
      `workspace: /work/${repo}`,
      `files: ${files}`,
      'severity: HIGH',
      'status: open',
      `finding_ids: agf_${id}`,
      // The attribution the old filter tripped over: the vessel id contains
      // "metabob-mcp" no matter which repository the finding is about.
      'recorded_by: metabob-mcp-a26287618176',
      'session: f510823f-15cc-40cc-ba9f-a3dee5aa5476',
      '',
      body,
    ].join('\n'),
  };
}

/** Stub concept-db behind the attachment: conceptSearch answers the corpus, with no verdicts. */
async function withCorpus<T>(rows: Row[], run: () => Promise<T>): Promise<T> {
  await installShapeStub({
    conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? rows : [], metadata: { shape: 'conceptSearch' } } }),
  });
  return run().finally(() => setAttachment(null));
}

const apiClient = {} as never;

const CORPUS: Row[] = [
  finding('mine1', 'metabob-mcp', 'src/local-store.ts', 'wal guard deletes healthy db'),
  finding('mine2', 'metabob-mcp', 'src/vessel-server.ts', 'resolver serves unauthenticated'),
  finding('other1', 'cachecontrol', 'cachecontrol/controller.py', 'cache key mismatch'),
  finding('other2', 'itsdangerous', 'src/itsdangerous/signer.py', 'timing leak'),
  finding('other3', 'metabob-dashboard', 'scripts/lease.mjs', 'lease refuses forever'),
];

describe('fetchAgentFindings repo scoping', () => {
  test('returns only findings whose declared repo is this repo', async () => {
    const res = await withCorpus(CORPUS, () =>
      fetchAgentFindings(apiClient, { repo: 'metabob-mcp' }),
    );

    expect(res.status).toBe('ok');
    expect(res.findings.map(f => f.id).sort()).toEqual(['mine1', 'mine2']);
  });

  test('a foreign finding is excluded despite a metabob-mcp vessel id in its body', async () => {
    // The precise regression: every row here carries
    // `recorded_by: metabob-mcp-...`, so a substring filter matched all five.
    const foreign = CORPUS.filter(r => !r.content.startsWith('repo: metabob-mcp\n'));
    expect(foreign).toHaveLength(3);
    for (const row of foreign) {
      expect(row.content).toContain('metabob-mcp'); // the bait is present …
    }

    const res = await withCorpus(foreign, () =>
      fetchAgentFindings(apiClient, { repo: 'metabob-mcp' }),
    );
    expect(res.findings).toEqual([]); // … and no longer taken
  });

  test('repo match is exact, so a sibling repo does not claim these findings', async () => {
    const res = await withCorpus(
      [finding('sib', 'metabob-mcp-sandbox', 'src/x.ts', 'sibling repo')],
      () => fetchAgentFindings(apiClient, { repo: 'metabob-mcp' }),
    );
    expect(res.findings).toEqual([]);
  });

  test('filePath narrows within the repo instead of widening across repos', async () => {
    const res = await withCorpus(CORPUS, () =>
      fetchAgentFindings(apiClient, { repo: 'metabob-mcp', filePath: 'src/local-store.ts' }),
    );
    expect(res.findings.map(f => f.id)).toEqual(['mine1']);
  });

  test('a filePath owned by another repo yields nothing, not that repo findings', async () => {
    const res = await withCorpus(CORPUS, () =>
      fetchAgentFindings(apiClient, { repo: 'metabob-mcp', filePath: 'controller.py' }),
    );
    expect(res.findings).toEqual([]);
  });

  test('legacy concepts with no repo: header still match, but not on attribution', async () => {
    const legacyMine: Row = {
      id: 'concept:legacy1',
      summary: 'an old finding about metabob-mcp internals',
      content: 'files: src/index.ts\nrecorded_by: metabob-mcp-a26287618176\n\nbody',
    };
    const legacyForeign: Row = {
      id: 'concept:legacy2',
      summary: 'an old finding about something else entirely',
      // Contains "metabob-mcp" ONLY in the attribution line.
      content: 'files: other/thing.py\nrecorded_by: metabob-mcp-a26287618176\n\nbody',
    };

    const res = await withCorpus([legacyMine, legacyForeign], () =>
      fetchAgentFindings(apiClient, { repo: 'metabob-mcp' }),
    );
    expect(res.findings.map(f => f.id)).toEqual(['legacy1']);
  });

  test('no resolvable repo declines rather than recalling every repo', async () => {
    const res = await withCorpus(CORPUS, () => fetchAgentFindings(apiClient, { repo: null }));
    expect(res.status).toBe('skipped');
    expect(res.findings).toEqual([]);
  });
});
