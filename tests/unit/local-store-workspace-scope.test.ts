/**
 * Regression: LocalStore reads are partitioned by workspace, and file_path is
 * matched the way get_problems documents it.
 *
 * ~/.metabob/sidecar.db is shared by every workspace on the machine. Before this
 * fix the schema keyed rows on workspace_id but no read predicate filtered on
 * it, so seeds recorded in repo A were served as repo B's problems — and,
 * because a non-empty cache short-circuits the live fetch, suppressed B's real
 * result. Separately, callers query with absolute paths while record_finding
 * stores workspace-relative ones, and the compare was exact, so a query silently
 * missed the rows it named.
 *
 * Assertions are on what a caller gets back, never on the SQL.
 * Every sqlite handle is closed before its temp dir is removed (Windows/EBUSY —
 * see tests/helpers/temp-store.ts).
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { makeTempStore, cleanupTempStores, trackStore } from '../helpers/temp-store';
import { LocalStore } from '../../src/local-store';
import { resolveWorkspaceId } from '../../src/workspace';

const foreignDirs: string[] = [];

afterEach(() => {
  cleanupTempStores();
  for (const d of foreignDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function foreignWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-foreign-ws-'));
  foreignDirs.push(d);
  return d;
}

function seed(store: LocalStore, over: Partial<Parameters<LocalStore['upsertSeed']>[0]>): string {
  const id = over.id ?? `agf_${Math.random().toString(16).slice(2)}`;
  store.upsertSeed({
    id,
    workspace_id: over.workspace_id ?? 'default',
    file_path: over.file_path ?? 'src/db/client.ts',
    line_start: over.line_start ?? 10,
    line_end: over.line_end ?? 12,
    category: over.category ?? 'correctness',
    severity: over.severity ?? 'HIGH',
    brief: over.brief ?? 'planted by the workspace-scope regression test',
    confidence: 1,
    refs_json: over.refs_json ?? '[]',
    produced_at: Date.now(),
    stale: over.stale ?? false,
  });
  return id;
}

describe('workspace scoping (audit finding 8)', () => {
  test('a seed recorded in another workspace is not served as this one’s', () => {
    const { store, dir } = makeTempStore('mcp-ws-scope-');
    store.setWorkspaceScope(dir);
    const other = foreignWorkspace();

    const mine = seed(store, { file_path: 'src/db/client.ts', brief: 'mine' });
    seed(store, { workspace_id: other, file_path: 'src/auth/plugin.ts', brief: 'theirs' });

    const all = store.getAllCachedSeeds();
    expect(all.map(s => s.id)).toEqual([mine]);
    expect(all.some(s => s.file_path === 'src/auth/plugin.ts')).toBe(false);

    // The foreign row is not reachable by naming its file either — that is the
    // path get_problems takes, and a foreign hit there gates the live fetch.
    expect(store.getCachedSeeds('src/auth/plugin.ts')).toEqual([]);
    expect(store.getSeedsForFile('src/auth/plugin.ts')).toEqual([]);
  });

  test('every writer’s workspace_id dialect still reads back as this workspace', () => {
    const { store, dir } = makeTempStore('mcp-ws-dialect-');
    store.setWorkspaceScope(dir);

    // record_finding / init_workspace write the absolute root; the scheduler and
    // watchers write resolveWorkspaceId()'s hash; the tool layer wrote 'default'.
    const byPath = seed(store, { workspace_id: dir, file_path: 'src/a.ts', brief: 'abs-path writer' });
    const byHash = seed(store, {
      workspace_id: store.workspaceScope().id,
      file_path: 'src/b.ts',
      brief: 'hash writer',
    });
    const bySentinel = seed(store, { workspace_id: 'default', file_path: 'src/c.ts', brief: 'sentinel writer' });

    const ids = new Set(store.getAllCachedSeeds().map(s => s.id));
    expect(ids).toEqual(new Set([byPath, byHash, bySentinel]));
  });

  test('markSeedsStale does not retire another workspace’s seed', () => {
    const { store, dir } = makeTempStore('mcp-ws-stale-');
    store.setWorkspaceScope(dir);
    const other = foreignWorkspace();

    const mine = seed(store, { file_path: 'src/shared.ts' });
    const theirs = seed(store, { workspace_id: other, file_path: 'src/shared.ts' });

    store.markSeedsStale(['src/shared.ts']);

    expect(store.getSeedById(mine)?.stale).toBe(true);
    expect(store.getSeedById(theirs)?.stale).toBe(false);
  });

  test('a seed written under the "default" alias is read as this workspace’s', () => {
    const { store, dir } = makeTempStore('mcp-ws-default-');
    store.setWorkspaceScope(dir);
    const other = foreignWorkspace();

    const mine = seed(store, { workspace_id: 'default', file_path: 'src/mine.ts' });
    seed(store, { workspace_id: other, file_path: 'src/theirs.ts' });

    expect(store.getAllCachedSeeds().map(s => s.id)).toEqual([mine]);
  });

  test('init drops a file-index and send-queue table, so no queued workspace paths stay on disk', () => {
    const { store, dbPath } = makeTempStore('mcp-ws-drop-');
    store.close();
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE schedule_queue (id TEXT PRIMARY KEY, file_path TEXT);
              INSERT INTO schedule_queue VALUES ('q1', '/work/src/secret.ts');
              CREATE TABLE files (path TEXT, workspace_id TEXT);`);
    raw.close();

    const reopened = trackStore(new LocalStore(dbPath));
    reopened.init();
    reopened.close();

    const check = new Database(dbPath);
    const tables = (check.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map(r => r.name);
    check.close();
    expect(tables).not.toContain('schedule_queue');
    expect(tables).not.toContain('files');
    expect(tables).toContain('seeds');
  });

  test('an id lookup stays cross-workspace — mark_complete accepts a finding recorded anywhere', () => {
    const { store, dir } = makeTempStore('mcp-ws-byid-');
    store.setWorkspaceScope(dir);
    const other = foreignWorkspace();

    const theirs = seed(store, { workspace_id: other, refs_json: '["concept:cf_elsewhere"]' });

    expect(store.getSeedById(theirs)?.id).toBe(theirs);
    expect(store.getSeedByConceptRef('cf_elsewhere')?.id).toBe(theirs);
  });

  test('the store’s workspace id is resolveWorkspaceId’s — the sync copy cannot drift', async () => {
    const { store } = makeTempStore('mcp-ws-hash-');
    // The repo root, so the git first-commit branch of the hash is exercised.
    const root = resolve(import.meta.dir, '..', '..');
    store.setWorkspaceScope(root);

    expect(store.workspaceScope().id).toBe(await resolveWorkspaceId(root));
  });

  test('the default scope follows WORKSPACE_PATH when no caller binds one', () => {
    const saved = process.env.WORKSPACE_PATH;
    const other = foreignWorkspace();
    try {
      process.env.WORKSPACE_PATH = other;
      const { store, dir } = makeTempStore('mcp-ws-env-');
      // dir is the DB location, not the workspace — the scope must come from env.
      expect(store.workspaceScope().root).toBe(resolve(other));
      expect(store.workspaceScope().root).not.toBe(resolve(dir));

      seed(store, { workspace_id: other, file_path: 'src/env.ts' });
      expect(store.getAllCachedSeeds().length).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.WORKSPACE_PATH;
      else process.env.WORKSPACE_PATH = saved;
    }
  });
});

describe('file_path matching (audit finding 16)', () => {
  test('a relative-stored seed is found by the absolute path a caller passes', () => {
    const { store, dir } = makeTempStore('mcp-ws-abs-');
    store.setWorkspaceScope(dir);
    const id = seed(store, { file_path: 'src/db/client.ts' }); // as record_finding stores it

    const found = store.getCachedSeeds(join(dir, 'src', 'db', 'client.ts'));
    expect(found.map(s => s.id)).toEqual([id]);
  });

  test('an absolute-stored seed is found by the relative path a caller passes', () => {
    const { store, dir } = makeTempStore('mcp-ws-rel-');
    store.setWorkspaceScope(dir);
    const id = seed(store, { file_path: join(dir, 'src', 'index.ts') });

    expect(store.getCachedSeeds('src/index.ts').map(s => s.id)).toEqual([id]);
    // …and the row itself is stored in the one path space.
    expect(store.getSeedById(id)?.file_path).toBe('src/index.ts');
  });

  test('file_path is a substring match, as the get_problems schema says', () => {
    const { store, dir } = makeTempStore('mcp-ws-substr-');
    store.setWorkspaceScope(dir);
    const target = seed(store, { file_path: 'src/local-store.ts' });
    seed(store, { file_path: 'src/vessel-server.ts' });

    expect(store.getCachedSeeds('local-store').map(s => s.id)).toEqual([target]);
    expect(store.getCachedSeeds('src/local-store.ts').map(s => s.id)).toEqual([target]);
    expect(store.getCachedSeeds('nothing-here')).toEqual([]);
  });

  test('an empty file_path selects nothing rather than the whole cache', () => {
    const { store, dir } = makeTempStore('mcp-ws-empty-');
    store.setWorkspaceScope(dir);
    seed(store, { file_path: 'src/a.ts' });

    expect(store.getCachedSeeds('')).toEqual([]);
    expect(store.getCachedSeeds('   ')).toEqual([]);
    expect(store.getAllCachedSeeds().length).toBe(1); // the seed is really there
  });

  test('a stale seed stays out of the cached reads regardless of how it is named', () => {
    const { store, dir } = makeTempStore('mcp-ws-stalefilter-');
    store.setWorkspaceScope(dir);
    seed(store, { file_path: 'src/gone.ts', stale: true });

    expect(store.getCachedSeeds('src/gone.ts')).toEqual([]);
    expect(store.getCachedSeeds(join(dir, 'src', 'gone.ts'))).toEqual([]);
    expect(store.getSeedsForFile('src/gone.ts').length).toBe(1); // unfiltered accessor
  });
});
