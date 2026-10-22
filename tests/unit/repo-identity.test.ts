/**
 * The findings ledger is keyed by repository identity, not by the workspace's
 * basename (SPEC §repository-identity): the normalized `origin` URL, else the
 * basename. Every repository called `app` in an org shared one ledger when the
 * basename was the key.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, setDefaultTimeout } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import { LocalStore } from '../../src/local-store';
import { setAttachment } from '../../src/attachment';
import { getLocalIndex } from '../../src/local-index';
import { clearRepoIdentityCache, normalizeRemoteUrl, repoIdentity } from '../../src/repo-identity';
import * as RecordFinding from '../../src/tools/record-finding';
import * as GetProblems from '../../src/tools/get-problems';
import { installShapeStub } from '../helpers/shape-stub';

// Spawns git or opens an on-disk store per test: well under a second normally, several on a stalled Windows runner.
setDefaultTimeout(30_000);

const apiClient = {} as AnalysisAPIClient;
const root = mkdtempSync(join(tmpdir(), 'metabob-repo-id-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A git repository at root/<rel> with the given origin (none when undefined). */
function repo(rel: string, origin?: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

describe('normalizeRemoteUrl', () => {
  test('every spelling of one remote is the same host/path', () => {
    const forms = [
      'git@github.com:Org/Repo.git',
      'https://github.com/org/repo',
      'https://github.com/Org/Repo.git/',
      'https://user:t0ken@github.com/org/repo.git',
      'ssh://git@github.com:22/org/repo.git',
      'git+ssh://git@GitHub.com/org/repo',
    ];
    for (const f of forms) expect(normalizeRemoteUrl(f)).toBe('github.com/org/repo');
  });

  test('a local-path remote keeps its path; a relative one resolves against the repository', () => {
    expect(normalizeRemoteUrl('/srv/git/Repo.git')).toBe('srv/git/repo');
    expect(normalizeRemoteUrl('file:///srv/git/repo.git')).toBe('srv/git/repo');
    expect(normalizeRemoteUrl('../upstream.git', '/home/me/work')).toBe('home/me/upstream');
  });

  test('an empty URL is no identity', () => {
    expect(normalizeRemoteUrl('  ')).toBeNull();
  });
});

describe('repoIdentity', () => {
  beforeEach(() => clearRepoIdentityCache());

  test('the origin URL, wherever the clone sits', () => {
    const a = repoIdentity(repo('clone-one/app', 'git@github.com:Org/App.git'));
    const b = repoIdentity(repo('clone-two/app-renamed', 'https://github.com/org/app'));
    expect(a).toEqual({ id: 'github.com/org/app', name: 'app', source: 'origin' });
    expect(b.id).toBe('github.com/org/app');
    expect(b.name).toBe('app-renamed');
  });

  test('a workspace below the repository root carries its subpath', () => {
    const top = repo('mono', 'https://github.com/org/mono');
    const pkg = join(top, 'packages', 'API');
    mkdirSync(pkg, { recursive: true });
    expect(repoIdentity(pkg).id).toBe('github.com/org/mono/packages/api');
  });

  test('no git remote falls back to the basename', () => {
    expect(repoIdentity(repo('no-remote/ws'))).toEqual({ id: 'ws', name: 'ws', source: 'basename' });
    const plain = join(root, 'plain', 'Thing');
    mkdirSync(plain, { recursive: true });
    // tmpdir() is outside any repository, so git finds none above it.
    expect(repoIdentity(plain)).toEqual({ id: 'Thing', name: 'Thing', source: 'basename' });
  });
});

describe('the ledger across repositories', () => {
  type Row = { id: string; summary: string; content: string; shape: string };
  let concepts: Row[];
  let store: LocalStore;
  let dbPath: string;
  let workspace: string;

  beforeEach(async () => {
    clearRepoIdentityCache();
    concepts = [];
    dbPath = join(root, `store-${Math.random().toString(16).slice(2)}.db`);
    store = new LocalStore(dbPath);
    store.init();
    spyOn(getLocalIndex(), 'workspacePath').mockImplementation(() => workspace);
    await installShapeStub({
      concept_create_write: (p) => {
        const row = { id: `concept_${concepts.length + 1}`, ...p.conceptData };
        concepts.push(row);
        return { body: { success: true, content: JSON.stringify(row) } };
      },
      conceptSearch: (p) => ({ body: { content: concepts.filter(c => c.shape === p.shape) } }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
    setAttachment(null);
    (getLocalIndex().workspacePath as unknown as { mockRestore(): void }).mockRestore();
  });

  async function record(at: string, summary: string): Promise<string> {
    workspace = at;
    return RecordFinding.handle(
      RecordFinding.InputSchema.parse({ files: ['src/index.ts'], summary, severity: 'HIGH', category: 'correctness' }),
      apiClient, 's', null,
    );
  }

  async function recall(at: string): Promise<string> {
    workspace = at;
    return GetProblems.handle(GetProblems.InputSchema.parse({}), apiClient, 's', null);
  }

  test('a finding carries repo: <identity> and repo_name: <basename>', async () => {
    await record(repo('carry/app', 'git@github.com:Org/App.git'), 'tokens leak');
    expect(concepts[0]!.content).toMatch(/^repo: github\.com\/org\/app$/m);
    expect(concepts[0]!.content).toMatch(/^repo_name: app$/m);
    expect(concepts[0]!.summary).toContain('app: tokens leak');
  });

  test('two repositories with one basename and different remotes do not share findings', async () => {
    await record(repo('team-a/app', 'git@github.com:team-a/app.git'), 'team a cache is stale');
    const other = await recall(repo('team-b/app', 'git@github.com:team-b/app.git'));
    expect(other).not.toContain('team a cache is stale');
  });

  test('one repository cloned at two paths shares its findings', async () => {
    await record(repo('first/app', 'git@github.com:Org/Shared.git'), 'shared race');
    const second = await recall(repo('second/elsewhere', 'https://github.com/org/shared'));
    expect(second).toContain('shared race');
  });

  test('a finding recorded under the legacy basename key is still recalled', async () => {
    concepts.push({
      id: 'concept_legacy',
      shape: 'code_finding',
      summary: '[HIGH][correctness] app: legacy finding',
      content: 'repo: app\nworkspace: /old/app\nfiles: src/index.ts\nseverity: HIGH\nstatus: open\nfinding_ids: agf_legacy',
    });
    const out = await recall(repo('legacy/app', 'git@github.com:Org/App.git'));
    expect(out).toContain('legacy finding');
  });
});
