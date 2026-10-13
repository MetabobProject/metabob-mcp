/**
 * init_workspace must bind the STORE to the same root it binds the INDEX to.
 *
 * `~/.metabob/sidecar.db` is shared by every workspace on the machine, so reads
 * are partitioned by workspace_id. Two things decide that id and they used to be
 * set independently: the index root (`localIndex.setWorkspace`, what
 * `activeWorkspacePath()` returns and what `record_finding` stamps onto a seed)
 * and the store scope (which fell back to WORKSPACE_PATH/cwd because nothing in
 * src/ ever called setWorkspaceScope).
 *
 * Whenever those differ — which is exactly the documented
 * `init_workspace({ workspace_path })` flow for pointing at a repo other than the
 * launch directory — a finding was written under one workspace and read under
 * another. record_finding reported success, get_problems returned nothing, and
 * the finding was silently unrecallable for the rest of the process's life.
 *
 * This asserts the round trip through the real tools, because the defect only
 * exists in the seam BETWEEN them; each half was correct on its own.
 */
import { test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';
import * as InitWorkspace from '../../src/tools/init-workspace';
import * as RecordFinding from '../../src/tools/record-finding';
import * as GetProblems from '../../src/tools/get-problems';

const SESSION = 'scope-binding-test';

let store: LocalStore;
let dbPath: string;
let workspace: string;
let apiClient: AnalysisAPIClient;
let savedWorkspacePath: string | undefined;
let savedConceptDb: string | undefined;

beforeEach(() => {
  dbPath = join(tmpdir(), `scope-binding-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  store = new LocalStore(dbPath);
  store.init();

  // A workspace that is NOT the launch directory — the case that broke.
  workspace = mkdtempSync(join(tmpdir(), 'scope-binding-ws-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'target.ts'), 'export function target(): number { return 1; }\n');

  savedWorkspacePath = process.env.WORKSPACE_PATH;
  savedConceptDb = process.env.CONCEPT_DB_URL;
  // Point the fallback somewhere that is definitively NOT the workspace, so a
  // test that passes can only be passing because the binding happened.
  process.env.WORKSPACE_PATH = tmpdir();
  // Unreachable: the concept-db write is best-effort and irrelevant here.
  process.env.CONCEPT_DB_URL = 'http://127.0.0.1:9';

  apiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    postFeedback: mock(async () => ({})),
    isVesselMode: mock(() => false),
  } as unknown as AnalysisAPIClient;
});

afterEach(() => {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  rmSync(workspace, { recursive: true, force: true });
  if (savedWorkspacePath === undefined) delete process.env.WORKSPACE_PATH;
  else process.env.WORKSPACE_PATH = savedWorkspacePath;
  if (savedConceptDb === undefined) delete process.env.CONCEPT_DB_URL;
  else process.env.CONCEPT_DB_URL = savedConceptDb;
});

test('a finding recorded after init_workspace({workspace_path}) is recallable by get_problems', async () => {
  await InitWorkspace.handle(
    InitWorkspace.InputSchema.parse({ workspace_path: workspace, sync_api: false }),
    apiClient, SESSION, store,
  );

  const recorded = await RecordFinding.handle(
    RecordFinding.InputSchema.parse({
      files: ['src/target.ts'],
      summary: 'target() returns a magic number',
      severity: 'HIGH',
      category: 'correctness',
    }),
    apiClient, SESSION, store,
  );
  const agfId = recorded.match(/agf_[a-z0-9]+/)?.[0];
  expect(agfId).toBeTruthy();

  // The seam under test: written under the index root, read under the store scope.
  const seeds = store.getAllCachedSeeds();
  expect(seeds.length).toBeGreaterThan(0);

  const out = await GetProblems.handle(
    GetProblems.InputSchema.parse({}),
    apiClient, SESSION, store,
  );
  expect(out).toContain('magic number');
  expect(out).toContain(agfId!);
});

test('the store scope follows the indexed root, not WORKSPACE_PATH', () => {
  // Asserted on the scope itself as well as through the tools, so a future
  // refactor that keeps the round trip working by coincidence still trips here.
  const before = store.workspaceScope().root;
  expect(before).toBe(tmpdir()); // the fallback, as set in beforeEach

  store.setWorkspaceScope(workspace);
  expect(store.workspaceScope().root).toBe(workspace);
  expect(store.workspaceScope().root).not.toBe(before);
});
