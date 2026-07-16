/**
 * Unit tests for the agent-side findings plane:
 *  - record_finding (LocalStore write path + non-fatal concept-db push)
 *  - mark_complete on agf_* ids (endorse/discard via LocalStore)
 *  - get_problems "Findings recorded by agents on this codebase" rendering
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';

import * as RecordFinding from '../../src/tools/record-finding';
import * as MarkComplete from '../../src/tools/mark-complete';
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

  dbPath = join(tmpdir(), `metabob-finding-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
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

// ===== schema =====

test('record_finding: schema requires files, summary, severity, category', () => {
  expect(() => RecordFinding.InputSchema.parse({})).toThrow();
  expect(() => RecordFinding.InputSchema.parse({ files: [], summary: 's', severity: 'HIGH', category: 'security' })).toThrow();
  expect(() => RecordFinding.InputSchema.parse({ files: ['a.ts'], summary: 's', severity: 'EXTREME', category: 'security' })).toThrow();
});

test('record_finding: schema defaults status to open', () => {
  const result = RecordFinding.InputSchema.parse({
    files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
  });
  expect(result.status).toBe('open');
});

// ===== localStore write path =====

test('record_finding: writes a seed per file that get_problems cache serves', async () => {
  const input = RecordFinding.InputSchema.parse({
    files: ['src/db/client.ts', 'src/db/pool.ts'],
    summary: 'SQL injection via string interpolation',
    severity: 'HIGH',
    category: 'security',
    line_start: 12,
    line_end: 18,
  });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);

  expect(output).toContain('agf_');
  expect(output).toContain('cached locally');
  expect(output).toContain('concept-db not configured');

  const seeds = localStore.getCachedSeeds('src/db/client.ts');
  expect(seeds.length).toBe(1);
  expect(seeds[0]!.id.startsWith('agf_')).toBe(true);
  expect(seeds[0]!.brief).toBe('SQL injection via string interpolation');
  expect(seeds[0]!.severity).toBe('HIGH');
  expect(seeds[0]!.category).toBe('security');
  expect(seeds[0]!.line_start).toBe(12);
  expect(seeds[0]!.line_end).toBe(18);
  expect(seeds[0]!.confidence).toBe(1);

  expect(localStore.getCachedSeeds('src/db/pool.ts').length).toBe(1);

  // The seed now surfaces through get_problems' local cache branch
  const problems = await GetProblems.handle(
    GetProblems.InputSchema.parse({ file_path: 'src/db/client.ts' }),
    mockApiClient, SESSION, localStore,
  );
  expect(problems).toContain('SQL injection via string interpolation');
  expect(problems).toContain('[HIGH] security');
});

test('record_finding: concept-db unreachable is non-fatal and reported', async () => {
  process.env.CONCEPT_DB_URL = 'http://127.0.0.1:9'; // nothing listens here
  const input = RecordFinding.InputSchema.parse({
    files: ['src/a.ts'], summary: 'off-by-one', severity: 'LOW', category: 'correctness',
  });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);
  expect(output).toContain('concept-db unreachable');
  expect(output).toContain('recorded locally only');
  expect(localStore.getCachedSeeds('src/a.ts').length).toBe(1);
});

test('record_finding: pushes a code_finding concept when concept-db is up', async () => {
  let received: Record<string, unknown> | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === 'POST' && new URL(req.url).pathname === '/concepts') {
        received = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: 'concept:cf_test1', shape: 'code_finding' });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  process.env.CONCEPT_DB_URL = `http://127.0.0.1:${server.port}`;

  const input = RecordFinding.InputSchema.parse({
    files: ['src/db/client.ts'], summary: 'SQL injection', severity: 'HIGH', category: 'security',
    details: 'user input concatenated into query',
  });
  const output = await RecordFinding.handle(input, mockApiClient, SESSION, localStore);

  expect(output).toContain('shared org-wide via concept-db');
  expect(output).toContain('cf_test1');
  expect(received).not.toBeNull();
  expect(received!['shape']).toBe('code_finding');
  expect(received!['source_type']).toBe('metabob_annotation');
  expect(String(received!['summary'])).toContain('[HIGH][security]');
  expect(String(received!['content'])).toContain('src/db/client.ts');
  expect(String(received!['content'])).toContain('user input concatenated into query');
});

// ===== mark_complete on agf_* ids =====

test('mark_complete: endorse retires an agf_* finding from the cache', async () => {
  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/b.ts'], summary: 'leak', severity: 'MEDIUM', category: 'resources' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'endorse' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('endorsed');
  expect(localStore.getCachedSeeds('src/b.ts').length).toBe(0);
  // seed still exists (stale), not deleted
  expect(localStore.getSeedById(id)?.stale).toBe(true);
  // legacy API was NOT called for agent findings
  expect(mockApiClient.postFeedback).not.toHaveBeenCalled();
});

test('mark_complete: discard deletes an agf_* finding', async () => {
  const recordOut = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({ files: ['src/c.ts'], summary: 'not a bug', severity: 'INFO', category: 'noise' }),
    mockApiClient, SESSION, localStore,
  );
  const id = recordOut.match(/agf_[a-z0-9]+/)![0];

  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: id, action: 'discard' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('discarded');
  expect(localStore.getSeedById(id)).toBeNull();
});

test('mark_complete: unknown agf_* id reports not found', async () => {
  const out = await MarkComplete.handle(
    MarkComplete.InputSchema.parse({ problem_id: 'agf_doesnotexist' }),
    mockApiClient, SESSION, localStore,
  );
  expect(out).toContain('not found');
});

// ===== get_problems cross-agent findings rendering =====

test('get_problems: renders findings recorded by agents on this codebase', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/concepts/search') {
        expect(url.searchParams.get('shape')).toBe('code_finding');
        expect(url.searchParams.get('query')).toBeNull(); // list mode only
        return Response.json({
          concepts: [
            {
              id: 'concept:cf_match',
              shape: 'code_finding',
              summary: '[HIGH][security] repo-x: SQL injection via string interpolation',
              content: 'repo: repo-x\nfiles: src/db/client.ts\nseverity: HIGH',
              updated_at: '2026-07-16T00:00:00Z',
            },
            {
              id: 'concept:cf_other',
              shape: 'code_finding',
              summary: '[LOW][style] other-repo: naming drift',
              content: 'repo: other-repo\nfiles: lib/naming.ts',
            },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  process.env.CONCEPT_DB_URL = `http://127.0.0.1:${server.port}`;

  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({ file_path: 'src/db/client.ts' }),
    mockApiClient, SESSION, null,
  );
  expect(out).toContain('Findings recorded by agents on this codebase');
  expect(out).toContain('SQL injection via string interpolation');
  expect(out).toContain('cf_match');
  // Non-matching repo's finding is filtered out
  expect(out).not.toContain('naming drift');
});

test('get_problems: concept-db unreachable is non-fatal', async () => {
  process.env.CONCEPT_DB_URL = 'http://127.0.0.1:9';
  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({ file_path: 'src/db/client.ts' }),
    mockApiClient, SESSION, null,
  );
  expect(typeof out).toBe('string');
  expect(out).toContain('concept-db unreachable');
});
