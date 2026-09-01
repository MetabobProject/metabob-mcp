/**
 * The seed cache must supplement the tools, never replace them (audit 9) and
 * must be readable without knowing a path (audit 10).
 *
 *  - analyze_impact used to return the cached-seed list INSTEAD OF the CPG
 *    traversal whenever any changed file carried a seed: `direction`,
 *    `max_depth` and every dependent silently vanished.
 *  - get_problems used to consult the local cache only when `file_path` was
 *    supplied, so the argument-less triage call — and therefore the agent
 *    findings the tool calls its primary source — saw nothing.
 */

import { test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';
import { getLocalIndex } from '../../src/local-index';

import * as AnalyzeImpact from '../../src/tools/analyze-impact';
import * as GetProblems from '../../src/tools/get-problems';

const SESSION = 'test-session';

let mockApiClient: AnalysisAPIClient;
let store: LocalStore;
let dbPath: string;
const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-cache-test-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content, 'utf-8');
  }
  return dir;
}

async function indexWorkspace(ws: string, files: string[]): Promise<void> {
  const index = getLocalIndex();
  await index.init();
  await index.setWorkspace(ws, files.length);
  for (const rel of files) {
    const abs = join(ws, rel);
    const content = readFileSync(abs, 'utf-8');
    await index.predictor.addFile(abs, content);
    index.recordImports(abs, content);
    index.markParsed(abs);
  }
}

function seed(overrides: Partial<Parameters<LocalStore['upsertSeed']>[0]> = {}) {
  return {
    id: `agf_${Math.random().toString(16).slice(2, 10)}`,
    workspace_id: 'default',
    file_path: 'src/core.ts',
    line_start: 1,
    line_end: 2,
    category: 'correctness',
    severity: 'HIGH',
    brief: 'a recorded finding',
    confidence: 1,
    refs_json: '[]',
    produced_at: Date.now() - 30_000,
    stale: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    getAnalysis: mock(async () => ({ status: 'complete', results: [] })),
    postFeedback: mock(async () => ({})),
    isVesselMode: mock(() => false),
  } as unknown as AnalysisAPIClient;

  dbPath = join(tmpdir(), `seed-cache-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  store = new LocalStore(dbPath);
  store.init();

  // Point the cross-agent recall at a closed port: it must stay out of these
  // assertions (and off the network) without being mocked away entirely.
  for (const k of ['CONCEPT_DB_URL', 'VESSEL_ID', 'METABOB_API_KEY', 'WORKSPACE_PATH']) {
    savedEnv[k] = process.env[k];
  }
  process.env['CONCEPT_DB_URL'] = 'http://127.0.0.1:9';
  delete process.env['VESSEL_ID'];
  delete process.env['METABOB_API_KEY'];
});

afterEach(() => {
  try {
    store.close(); // before rm: an open sqlite handle makes rmSync EBUSY on Windows
  } finally {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

afterAll(async () => {
  // The index is a module singleton — hand it back empty so a later test file
  // cannot inherit this one's graph.
  await getLocalIndex().setWorkspace(makeWorkspace({}), 0);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ===== audit 9: analyze_impact =====

test('analyze_impact: cached seeds supplement the traversal instead of replacing it', async () => {
  const ws = makeWorkspace({
    'src/core.ts': 'export function core() { return 1; }\n',
    'src/consumer.ts': "import { core } from './core.js';\nexport function consumer() { return core(); }\n",
  });
  await indexWorkspace(ws, ['src/core.ts', 'src/consumer.ts']);

  store.setWorkspaceScope(ws);
  store.upsertSeed(seed({ file_path: join(ws, 'src/core.ts'), brief: 'unchecked cast in core()' }));

  const out = await AnalyzeImpact.handle(
    AnalyzeImpact.InputSchema.parse({ changed_files: [join(ws, 'src/core.ts')], direction: 'backward' }),
    mockApiClient, SESSION, store,
  );

  // The traversal ran: the importer is reported as an affected component.
  // Match on the basename: the tool renders the platform's own separator, and
  // asserting a POSIX path here fails on Windows, which CI builds.
  expect(out).toContain('Impact Analysis');
  expect(out).toContain('consumer.ts');
  expect(out).not.toContain('Impact Analysis (cached)');
  // …and the seed rode along rather than displacing it.
  expect(out).toContain('unchecked cast in core()');
  expect(out).toContain('Known problems in changed files');
  // Ordering is the whole point: analysis first, seeds appended after it.
  expect(out.indexOf('src/consumer.ts')).toBeLessThan(out.indexOf('unchecked cast in core()'));
});

test('analyze_impact: seeds still ride along when the file is not in the graph', async () => {
  const ws = makeWorkspace({ 'src/core.ts': 'export function core() { return 1; }\n' });
  await indexWorkspace(ws, ['src/core.ts']);

  store.setWorkspaceScope(ws);
  store.upsertSeed(seed({ file_path: 'src/ghost.ts', brief: 'finding on an unindexed file' }));

  const out = await AnalyzeImpact.handle(
    AnalyzeImpact.InputSchema.parse({ changed_files: ['src/ghost.ts'] }),
    mockApiClient, SESSION, store,
  );

  expect(out).toContain('No indexed components found');
  expect(out).toContain('finding on an unindexed file');
});

test('analyze_impact: an empty cache leaves the traversal untouched and enqueues the file', async () => {
  const ws = makeWorkspace({
    'src/core.ts': 'export function core() { return 1; }\n',
    'src/consumer.ts': "import { core } from './core.js';\nexport function consumer() { return core(); }\n",
  });
  await indexWorkspace(ws, ['src/core.ts', 'src/consumer.ts']);
  store.setWorkspaceScope(ws);

  const out = await AnalyzeImpact.handle(
    AnalyzeImpact.InputSchema.parse({ changed_files: [join(ws, 'src/core.ts')], direction: 'backward' }),
    mockApiClient, SESSION, store,
  );

  // Basename, not a POSIX path — see the note on the assertion above.
  expect(out).toContain('consumer.ts');
  expect(out).not.toContain('Known problems in changed files');
  expect(store.dequeue(10).some(q => q.file_path.includes('core.ts'))).toBe(true);
});

// ===== audit 10: get_problems =====

test('get_problems: the argument-less call reads the whole workspace seed cache', async () => {
  const ws = makeWorkspace({});
  store.setWorkspaceScope(ws);
  store.upsertSeed(seed({ id: 'agf_alpha', file_path: 'src/a.ts', brief: 'race in the retry loop' }));
  store.upsertSeed(seed({ id: 'agf_beta', file_path: 'src/b.ts', brief: 'unbounded queue growth', severity: 'CRITICAL' }));

  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    mockApiClient, SESSION, store,
  );

  // Both findings, in different files, with the ids mark_complete needs.
  expect(out).toContain('race in the retry loop');
  expect(out).toContain('unbounded queue growth');
  expect(out).toContain('agf_alpha');
  expect(out).toContain('agf_beta');
  // Severity order is preserved workspace-wide, not just per file.
  expect(out.indexOf('unbounded queue growth')).toBeLessThan(out.indexOf('race in the retry loop'));
  // Cache-served output is labelled, and dated from the seeds when no backend
  // analysis record exists for the file (this used to render "Infinitys old").
  expect(out).toContain('[cache:');
  expect(out).not.toContain('Infinity');
  // A cache hit short-circuits the legacy fetch.
  expect(mockApiClient.getAnalysis).not.toHaveBeenCalled();
});

test('get_problems: filters and limit still apply to the workspace-wide read', async () => {
  const ws = makeWorkspace({});
  store.setWorkspaceScope(ws);
  store.upsertSeed(seed({ id: 'agf_high', file_path: 'src/a.ts', brief: 'high one', severity: 'HIGH' }));
  store.upsertSeed(seed({ id: 'agf_crit', file_path: 'src/b.ts', brief: 'critical one', severity: 'CRITICAL' }));

  const filtered = await GetProblems.handle(
    GetProblems.InputSchema.parse({ severity: ['CRITICAL'] }),
    mockApiClient, SESSION, store,
  );
  expect(filtered).toContain('critical one');
  expect(filtered).not.toContain('high one');

  const limited = await GetProblems.handle(
    GetProblems.InputSchema.parse({ limit: 1 }),
    mockApiClient, SESSION, store,
  );
  expect(limited).toContain('critical one');
  expect(limited).not.toContain('high one');
  expect(limited).toContain('2 total after filters');
});

test('get_problems: an empty seed cache still falls through to the live fetch', async () => {
  const ws = makeWorkspace({});
  store.setWorkspaceScope(ws);

  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    mockApiClient, SESSION, store,
  );

  expect(mockApiClient.getAnalysis).toHaveBeenCalledWith(SESSION);
  expect(out).toContain('No problems found');
});

test('get_problems: another workspace\'s seeds are not served here', async () => {
  const mine = makeWorkspace({});
  const theirs = makeWorkspace({});
  store.setWorkspaceScope(theirs);
  store.upsertSeed(seed({ id: 'agf_elsewhere', file_path: 'src/a.ts', brief: 'someone else repo finding' }));

  store.setWorkspaceScope(mine);
  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    mockApiClient, SESSION, store,
  );

  expect(out).not.toContain('someone else repo finding');
  expect(out).toContain('No problems found');
});
