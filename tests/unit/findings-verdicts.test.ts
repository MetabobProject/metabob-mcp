/**
 * Unit tests for verdict-aware finding recall + local seeds in the ranked list:
 *  - parseFindingIds / parseVerdictConcept (join keys between code_finding and
 *    finding_verdict concepts on the shared agf_* id)
 *  - fetchAgentFindings joining finding_verdict concepts to code_finding rows
 *  - renderFindingsSection moving closed findings out of the open presentation
 *    ([FIXED]/[RETRACTED] tags; compact one-line count)
 *  - get_problems surfacing agf_* seeds in the ranked list WITHOUT file_path
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore, type SeedRecord } from '../../src/local-store';

import {
  fetchAgentFindings,
  parseFindingIds,
  parseVerdictConcept,
  renderFindingsSection,
  type AgentFindingsResult,
} from '../../src/tools/_findings';
import * as GetProblems from '../../src/tools/get-problems';

const SESSION = 'test-session';

let mockApiClient: AnalysisAPIClient;
let localStore: LocalStore;
let dbPath: string;
let savedConceptDbUrl: string | undefined;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    getAnalysis: mock(async () => ({ status: 'complete', results: [] })),
    postFeedback: mock(async () => ({})),
    isVesselMode: mock(() => false),
  } as unknown as AnalysisAPIClient;

  dbPath = join(tmpdir(), `metabob-verdict-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  localStore = new LocalStore(dbPath);
  localStore.init();

  savedConceptDbUrl = process.env.CONCEPT_DB_URL;
  delete process.env.CONCEPT_DB_URL;
});

afterEach(() => {
  localStore.close();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(dbPath + suffix, { force: true });
  }
  if (savedConceptDbUrl === undefined) delete process.env.CONCEPT_DB_URL;
  else process.env.CONCEPT_DB_URL = savedConceptDbUrl;
  for (const s of servers.splice(0)) s.stop(true);
});

function makeSeed(overrides: Partial<SeedRecord>): SeedRecord {
  return {
    id: `agf_${Math.random().toString(36).slice(2, 10)}`,
    // 'default' is the sentinel the tool layer passes for "the workspace this
    // process serves"; the store collapses it to the canonical id. An arbitrary
    // literal here would be a genuinely foreign workspace and correctly
    // invisible to every listing read — these seeds are meant to be ours.
    workspace_id: 'default',
    file_path: 'src/a.ts',
    line_start: 1,
    line_end: 2,
    category: 'correctness',
    severity: 'MEDIUM',
    brief: 'a finding',
    confidence: 1,
    refs_json: '[]',
    produced_at: Date.now(),
    read_at: null,
    stale: false,
    ...overrides,
  };
}

// ===== join-key parsing =====

test('parseFindingIds: extracts agf ids from record_finding content format', () => {
  const content = [
    'repo: metabob-mcp',
    'workspace: ws',
    'files: src/a.ts, src/b.ts',
    'severity: HIGH',
    'category: security',
    'status: open',
    'finding_ids: agf_abc123, agf_def456',
  ].join('\n');
  expect(parseFindingIds(content)).toEqual(['agf_abc123', 'agf_def456']);
});

test('parseFindingIds: empty for "(not cached locally)" and missing line', () => {
  expect(parseFindingIds('finding_ids: (not cached locally)')).toEqual([]);
  expect(parseFindingIds('repo: x\nfiles: src/a.ts')).toEqual([]);
});

test('parseVerdictConcept: endorse and discard in mark_complete write format', () => {
  const endorse = parseVerdictConcept(
    ['finding: agf_abc123', 'verdict: endorsed (resolved)', 'repo: metabob-mcp'].join('\n'),
    '[verdict:endorse] metabob-mcp: off by one',
  );
  expect(endorse).toEqual({ findingId: 'agf_abc123', verdict: 'fixed' });

  const discard = parseVerdictConcept(
    ['finding: agf_def456', 'verdict: discarded (retracted)', 'repo: metabob-mcp'].join('\n'),
    '[verdict:discard] metabob-mcp: not a bug',
  );
  expect(discard).toEqual({ findingId: 'agf_def456', verdict: 'retracted' });
});

test('parseVerdictConcept: falls back to the summary tag; null without a finding id', () => {
  expect(parseVerdictConcept('finding: agf_x1', '[verdict:discard] repo: x')).toEqual({
    findingId: 'agf_x1',
    verdict: 'retracted',
  });
  expect(parseVerdictConcept('verdict: endorsed (resolved)', '[verdict:endorse] x')).toBeNull();
  expect(parseVerdictConcept('finding: agf_x1', 'no tag here')).toBeNull();
});

// ===== fetchAgentFindings verdict join =====

function conceptDbServer(
  findingRows: Array<Record<string, unknown>>,
  verdictRows: Array<Record<string, unknown>> | 'fail',
) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/concepts/search') {
        const shape = url.searchParams.get('shape');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (shape === 'code_finding') {
          return Response.json({ concepts: offset === 0 ? findingRows : [] });
        }
        if (shape === 'finding_verdict') {
          if (verdictRows === 'fail') return new Response('boom', { status: 500 });
          return Response.json({ concepts: offset === 0 ? verdictRows : [] });
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  process.env.CONCEPT_DB_URL = `http://127.0.0.1:${server.port}`;
  return server;
}

const FINDING_ROW = {
  id: 'concept:cf_open1',
  summary: '[HIGH][security] metabob-mcp: SQL injection',
  content: 'repo: metabob-mcp\nfiles: src/db.ts\nfinding_ids: agf_open1',
};
const CLOSED_ROW = {
  id: 'concept:cf_closed1',
  summary: '[MEDIUM][correctness] metabob-mcp: off by one',
  content: 'repo: metabob-mcp\nfiles: src/x.ts\nfinding_ids: agf_closed1',
};

test('fetchAgentFindings: joins finding_verdict concepts on the shared agf id', async () => {
  conceptDbServer(
    [FINDING_ROW, CLOSED_ROW],
    [
      {
        id: 'concept:fv_1',
        summary: '[verdict:discard] metabob-mcp: off by one',
        content: 'finding: agf_closed1\nverdict: discarded (retracted)',
      },
    ],
  );

  const result = await fetchAgentFindings(mockApiClient, { repo: 'metabob-mcp' });
  expect(result.status).toBe('ok');
  expect(result.findings).toHaveLength(2);
  const open = result.findings.find(f => f.id === 'cf_open1');
  const closed = result.findings.find(f => f.id === 'cf_closed1');
  expect(open?.verdict).toBeUndefined();
  expect(closed?.verdict).toBe('retracted');
});

test('fetchAgentFindings: endorse verdict tags the finding fixed; retraction wins over endorse', async () => {
  conceptDbServer(
    [CLOSED_ROW],
    [
      {
        id: 'concept:fv_e',
        summary: '[verdict:endorse] metabob-mcp: off by one',
        content: 'finding: agf_closed1\nverdict: endorsed (resolved)',
      },
      {
        id: 'concept:fv_d',
        summary: '[verdict:discard] metabob-mcp: off by one',
        content: 'finding: agf_closed1\nverdict: discarded (retracted)',
      },
    ],
  );
  const result = await fetchAgentFindings(mockApiClient, { repo: 'metabob-mcp' });
  expect(result.findings[0]?.verdict).toBe('retracted');
});

test('fetchAgentFindings: failed verdict scan degrades to unverdicted rendering', async () => {
  conceptDbServer([CLOSED_ROW], 'fail');
  const result = await fetchAgentFindings(mockApiClient, { repo: 'metabob-mcp' });
  expect(result.status).toBe('ok');
  expect(result.findings[0]?.verdict).toBeUndefined();
});

test('fetchAgentFindings: emits plain concept ids (concept: prefix and ⟨⟩ wrapping stripped)', async () => {
  conceptDbServer(
    [{ ...FINDING_ROW, id: '⟨concept:cf_wrapped⟩' }],
    [],
  );
  const result = await fetchAgentFindings(mockApiClient, { repo: 'metabob-mcp' });
  expect(result.findings[0]?.id).toBe('cf_wrapped');
});

// ===== renderFindingsSection open/closed split =====

function findingsResult(findings: AgentFindingsResult['findings']): AgentFindingsResult {
  return { status: 'ok', findings, truncated: false, scanned: findings.length };
}

test('renderFindingsSection: closed findings move to a tagged closed section', () => {
  const text = renderFindingsSection(
    findingsResult([
      { id: 'cf_open1', summary: 'open issue', content: 'files: src/a.ts' },
      { id: 'cf_fixed1', summary: 'was fixed', content: 'files: src/b.ts', verdict: 'fixed' },
      { id: 'cf_gone1', summary: 'false positive', content: 'files: src/c.ts', verdict: 'retracted' },
    ]),
    { max: 10 },
  );
  const openSection = text.split('Closed findings')[0]!;
  expect(openSection).toContain('open issue');
  expect(openSection).not.toContain('was fixed');
  expect(openSection).not.toContain('false positive');
  expect(text).toContain('Closed findings (verdict recorded — not open issues):');
  expect(text).toContain('[FIXED] was fixed');
  expect(text).toContain('[RETRACTED] false positive');
});

test('renderFindingsSection: all-closed renders "none open" plus the closed section', () => {
  const text = renderFindingsSection(
    findingsResult([{ id: 'cf_1', summary: 'done', content: '', verdict: 'fixed' }]),
    { max: 10 },
  );
  expect(text).toContain('none open');
  expect(text).toContain('[FIXED] done');
});

test('renderFindingsSection: compact mode collapses closed findings to a count line', () => {
  const text = renderFindingsSection(
    findingsResult([
      { id: 'cf_open1', summary: 'open issue', content: '' },
      { id: 'cf_fixed1', summary: 'was fixed', content: '', verdict: 'fixed' },
      { id: 'cf_gone1', summary: 'false positive', content: '', verdict: 'retracted' },
    ]),
    { max: 5, compact: true },
  );
  expect(text).toContain('open issue');
  expect(text).toContain('(2 closed findings suppressed: 1 [FIXED], 1 [RETRACTED])');
  expect(text).not.toContain('was fixed');
});

// ===== get_problems: seeds in the ranked list without file_path =====

test('get_problems: agf_* seeds surface in the default call (no file_path), severity-ranked', async () => {
  localStore.upsertSeed(makeSeed({ id: 'agf_low1', severity: 'LOW', brief: 'low issue', file_path: 'src/z.ts' }));
  localStore.upsertSeed(makeSeed({ id: 'agf_crit1', severity: 'CRITICAL', brief: 'critical issue', file_path: 'src/a.ts' }));

  const output = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    mockApiClient,
    SESSION,
    localStore,
  );

  expect(output).toContain('agf_crit1');
  expect(output).toContain('agf_low1');
  // Severity-ranked: CRITICAL before LOW
  expect(output.indexOf('critical issue')).toBeLessThan(output.indexOf('low issue'));
  // Not served from the backend path
  expect(output).toContain('2 problems');
});

test('get_problems: default call excludes stale (endorsed) and deleted (discarded) seeds', async () => {
  localStore.upsertSeed(makeSeed({ id: 'agf_keep', brief: 'still open' }));
  localStore.upsertSeed(makeSeed({ id: 'agf_endorsed', brief: 'already fixed' }));
  localStore.upsertSeed(makeSeed({ id: 'agf_discarded', brief: 'false positive' }));
  localStore.markSeedStaleById('agf_endorsed');
  localStore.deleteSeed('agf_discarded');

  const output = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    mockApiClient,
    SESSION,
    localStore,
  );

  expect(output).toContain('agf_keep');
  expect(output).not.toContain('agf_endorsed');
  expect(output).not.toContain('agf_discarded');
});

test('get_problems: default call with an empty seed cache still falls through to the backend', async () => {
  const output = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    mockApiClient,
    SESSION,
    localStore,
  );
  // legacy path with zero results
  expect(output).toContain('No problems found');
});

test('get_problems: severity filter applies to the all-files seed list', async () => {
  localStore.upsertSeed(makeSeed({ id: 'agf_hi', severity: 'HIGH', brief: 'high issue' }));
  localStore.upsertSeed(makeSeed({ id: 'agf_lo', severity: 'LOW', brief: 'low issue' }));

  const output = await GetProblems.handle(
    GetProblems.InputSchema.parse({ severity: ['HIGH'] }),
    mockApiClient,
    SESSION,
    localStore,
  );
  expect(output).toContain('agf_hi');
  expect(output).not.toContain('agf_lo');
});
