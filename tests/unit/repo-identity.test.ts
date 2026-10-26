/**
 * The findings ledger is keyed by repository identity, not by the workspace's
 * basename (SPEC §repository-identity): the normalized `origin` URL, else the
 * first commit, else the directory alone. Every repository called `app` in an
 * org would share one ledger if the basename were the key.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const apiClient = {} as AnalysisAPIClient;
const root = mkdtempSync(join(tmpdir(), 'metabob-repo-id-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

/** A commit in `dir` with `file` set to `text`, dated `when` (seconds since the epoch). */
function commit(dir: string, file: string, text: string, when: number): void {
  writeFileSync(join(dir, file), text);
  execFileSync('git', ['-C', dir, 'add', file]);
  const date = `@${when} +0000`;
  execFileSync('git', ['-C', dir, ...GIT_ID, 'commit', '-q', '-m', text], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

const sha = (dir: string, rev = 'HEAD') => execFileSync('git', ['-C', dir, 'rev-parse', rev], { encoding: 'utf8' }).trim();

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

  test('no git remote: the first commit names the repository', () => {
    const ws = repo('no-remote/ws');
    commit(ws, 'a.txt', 'first', 1_700_000_000);
    const first = sha(ws);
    commit(ws, 'b.txt', 'second', 1_700_000_100);
    expect(repoIdentity(ws)).toEqual({ id: `root:${first}`, name: 'ws', source: 'root' });
    const pkg = join(ws, 'Pkg');
    mkdirSync(pkg);
    expect(repoIdentity(pkg).id).toBe(`root:${first}/pkg`);
  });

  test('two unrelated repositories with one name and no remote get different identities', () => {
    const a = repo('alone-a/app');
    const b = repo('alone-b/app');
    commit(a, 'x.txt', 'a', 1_700_000_000);
    commit(b, 'x.txt', 'b', 1_700_000_000);
    expect(repoIdentity(a).id).not.toBe(repoIdentity(b).id);
    expect(repoIdentity(a).name).toBe(repoIdentity(b).name);
  });

  test('two copies of one history with no remote share an identity', () => {
    const a = repo('copy-a/app');
    commit(a, 'x.txt', 'one', 1_700_000_000);
    const b = join(root, 'copy-b', 'renamed');
    cpSync(a, b, { recursive: true });
    commit(b, 'y.txt', 'later, in the copy only', 1_700_000_500);
    expect(repoIdentity(b)).toEqual({ id: repoIdentity(a).id, name: 'renamed', source: 'root' });
  });

  test('with several roots, the oldest by commit time, then the lowest sha, in every copy', () => {
    const a = repo('roots/app');
    commit(a, 'x.txt', 'newer root', 1_700_000_900);
    const newer = sha(a);
    execFileSync('git', ['-C', a, 'checkout', '-q', '--orphan', 'other']);
    execFileSync('git', ['-C', a, 'rm', '-q', '-rf', '.']);
    commit(a, 'z.txt', 'older root', 1_700_000_000);
    const older = sha(a);
    execFileSync('git', ['-C', a, ...GIT_ID, 'merge', '-q', '--allow-unrelated-histories', '-m', 'join', newer]);
    expect(repoIdentity(a).id).toBe(`root:${older}`);
    // The same merged history entered from the other side picks the same root.
    const b = join(root, 'roots-copy', 'app');
    cpSync(a, b, { recursive: true });
    execFileSync('git', ['-C', b, 'checkout', '-q', '-B', 'side', newer]);
    execFileSync('git', ['-C', b, ...GIT_ID, 'merge', '-q', '--allow-unrelated-histories', '-m', 'join', older]);
    expect(repoIdentity(b).id).toBe(`root:${older}`);
  });

  test('with no commit, or no git, the identity is the directory alone', () => {
    const empty = repoIdentity(repo('empty-a/ws'));
    expect(empty.source).toBe('local');
    expect(empty.id).toMatch(/^local:[0-9a-f]{16}$/);
    expect(empty.id).not.toBe(repoIdentity(repo('empty-b/ws')).id);
    const plain = join(root, 'plain', 'Thing');
    mkdirSync(plain, { recursive: true });
    // tmpdir() is outside any repository, so git finds none above it.
    expect(repoIdentity(plain)).toMatchObject({ name: 'Thing', source: 'local' });
  });

  test('a clone that gains an origin is keyed by it', () => {
    const ws = repo('gains/app');
    commit(ws, 'x.txt', 'x', 1_700_000_000);
    expect(repoIdentity(ws).source).toBe('root');
    execFileSync('git', ['-C', ws, 'remote', 'add', 'origin', 'git@github.com:Org/App.git']);
    clearRepoIdentityCache();
    expect(repoIdentity(ws)).toEqual({ id: 'github.com/org/app', name: 'app', source: 'origin' });
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

  test('two repositories with one name and no remote do not share findings', async () => {
    const a = repo('ledger-a/app');
    const b = repo('ledger-b/app');
    commit(a, 'x.txt', 'a', 1_700_000_000);
    commit(b, 'x.txt', 'b', 1_700_000_000);
    await record(a, 'only in the first app');
    expect(concepts[0]!.content).toMatch(/^repo: root:[0-9a-f]{40}$/m);
    expect(await recall(b)).not.toContain('only in the first app');
    expect(await recall(a)).toContain('only in the first app');
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
    const rootKeyed = repo('legacy-root/app');
    commit(rootKeyed, 'x.txt', 'x', 1_700_000_000);
    expect(await recall(rootKeyed)).toContain('legacy finding');
  });
});
