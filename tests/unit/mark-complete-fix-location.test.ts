/**
 * An endorse records where the fix is, and a fix that is still uncommitted does not close the finding
 * (SPEC §mark_complete). On the lab an agent endorsed a fix that lived only in its own working tree: the finding
 * closed org-wide while every other checkout still had the bug, and the next agents read "fixed" over a file that
 * was not.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';
import type { SeedRecord } from '../../src/local-store';
import { setAttachment } from '../../src/attachment';
import { GIT_ENV, commitInHead, fixLocation, setFixGitTimeoutForTests } from '../../src/repo-identity';
import * as MarkComplete from '../../src/tools/mark-complete';
import { fetchAgentFindings, parseVerdictConcept, renderFindingsSection } from '../../src/tools/_findings';
import { installShapeStub } from '../helpers/shape-stub';
import { cleanupTempStores, makeTempStore } from '../helpers/temp-store';

const root = mkdtempSync(join(tmpdir(), 'metabob-fixloc-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  cleanupTempStores();
  setAttachment(null);
});

const api = {} as AnalysisAPIClient;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
}

const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

/** A repository with stats.ts and util.ts committed on branch `main` an hour ago, before any finding. */
function checkout(name: string): string {
  const dir = join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'stats.ts'), 'export const average = (xs: number[]) => xs.length;\n');
  writeFileSync(join(dir, 'util.ts'), 'export const sum = (xs: number[]) => xs.length;\n');
  git(dir, 'add', '.');
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'stats'],
    { env: { ...process.env, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } });
  return dir;
}

describe('fixLocation', () => {
  test('a commit since the finding touching its files is the fix; edits and new files are uncommitted', () => {
    const dir = checkout('loc');
    const head = git(dir, 'rev-parse', 'HEAD');
    const recorded = new Date();
    writeFileSync(join(dir, 'stats.ts'), 'export const average = (xs: number[]) => 0;\n');
    expect(fixLocation(dir, ['stats.ts'], recorded)).toEqual({ kind: 'uncommitted', branch: 'main', base: head });
    git(dir, 'commit', '-qam', 'fix');
    const fix = git(dir, 'rev-parse', 'HEAD');
    expect(fixLocation(dir, ['stats.ts'], recorded)).toEqual({ kind: 'commit', sha: fix, branch: 'main', pushed: false });
    writeFileSync(join(dir, 'median.ts'), 'x\n');
    expect(fixLocation(dir, ['stats.ts', 'median.ts'], recorded).kind).toBe('uncommitted');
    expect(fixLocation(mkdtempSync(join(root, 'plain-')), ['stats.ts'])).toEqual({ kind: 'unknown' });
  });

  test('a commit older than the finding is never its fix, and a path git does not know is unknown, never HEAD', () => {
    const dir = checkout('old');
    expect(fixLocation(dir, ['stats.ts'], new Date())).toEqual({ kind: 'none' });
    expect(fixLocation(dir, ['src/nope.ts'], new Date())).toEqual({ kind: 'absent' });
    // With no recorded time no commit can be shown to postdate the finding.
    writeFileSync(join(dir, 'stats.ts'), 'fixed\n');
    git(dir, 'commit', '-qam', 'fix');
    expect(fixLocation(dir, ['stats.ts'])).toEqual({ kind: 'none' });
    expect(fixLocation(dir, ['stats.ts'], new Date(Date.now() - 60_000)).kind).toBe('commit');
  });

  test('a fix in another file: uncommitted there is pending (outside); committed, it is named but not taken unless claimed', () => {
    const dir = checkout('other');
    const recorded = new Date();
    writeFileSync(join(dir, 'util.ts'), 'export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n');
    expect(fixLocation(dir, ['stats.ts'], recorded)).toMatchObject({ kind: 'uncommitted', outside: true });
    git(dir, 'commit', '-qam', 'fix sum');
    const fix = git(dir, 'rev-parse', 'HEAD');
    // A pull of unrelated work must not close every finding: the newer commit is named, not taken.
    expect(fixLocation(dir, ['stats.ts'], recorded)).toEqual({ kind: 'none', newest: { sha: fix, files: ['util.ts'] } });
    expect(fixLocation(dir, ['stats.ts'], recorded, fix.slice(0, 7)))
      .toEqual({ kind: 'commit', sha: fix, branch: 'main', pushed: false, claimed: true, elsewhere: true });
  });

  test('a claimed fix commit must exist here, be in HEAD and postdate the finding', () => {
    const dir = checkout('claim');
    const old = git(dir, 'rev-parse', 'HEAD');
    const recorded = new Date();
    expect(fixLocation(dir, ['stats.ts'], recorded, old)).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('predates the finding') });
    expect(fixLocation(dir, ['stats.ts'], recorded, 'deadbeef')).toMatchObject({ kind: 'rejected', reason: 'deadbeef is not a commit in this checkout' });
    git(dir, 'checkout', '-qb', 'side');
    writeFileSync(join(dir, 'util.ts'), 'side\n');
    git(dir, 'commit', '-qam', 'side');
    const side = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    expect(fixLocation(dir, ['stats.ts'], recorded, side)).toMatchObject({ kind: 'rejected', reason: expect.stringContaining("is not in this checkout's HEAD") });
    expect(fixLocation(dir, ['stats.ts'], undefined, old)).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('no recorded time') });
    // Uncommitted changes in the finding's files win over a claim.
    writeFileSync(join(dir, 'util.ts'), 'claim\n');
    git(dir, 'commit', '-qam', 'claim');
    const claim = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'stats.ts'), 'dirty\n');
    expect(fixLocation(dir, ['stats.ts'], recorded, claim)).toMatchObject({ kind: 'uncommitted' });
    git(dir, 'checkout', '-q', '--', 'stats.ts');
    expect(fixLocation(dir, ['stats.ts'], recorded, claim)).toMatchObject({ kind: 'commit', sha: claim, claimed: true, elsewhere: true });
    // A claimed commit touching the finding's files is not "elsewhere".
    writeFileSync(join(dir, 'stats.ts'), 'fixed\n');
    git(dir, 'commit', '-qam', 'fix');
    const fix = git(dir, 'rev-parse', 'HEAD');
    expect(fixLocation(dir, ['stats.ts'], recorded, fix)).toEqual({ kind: 'commit', sha: fix, branch: 'main', pushed: false, claimed: true });
  });

  test('commitInHead: HEAD\'s history yes, another branch\'s commit or an unknown one no, no git null', () => {
    const dir = checkout('head');
    const base = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-qb', 'fix');
    writeFileSync(join(dir, 'stats.ts'), 'fixed\n');
    git(dir, 'commit', '-qam', 'fix');
    const fix = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    expect(commitInHead(dir, base)).toBe(true);
    expect(commitInHead(dir, fix)).toBe(false);
    expect(commitInHead(dir, '0123456789abcdef0123456789abcdef01234567')).toBe(false);
    expect(commitInHead(mkdtempSync(join(root, 'plain-')), base)).toBeNull();
  });
});

describe('mark_complete endorse', () => {
  function seeded() {
    const { store } = makeTempStore('fixloc-');
    const seed: SeedRecord = {
      id: 'agf_avg1', workspace_id: 'default', file_path: 'stats.ts', line_start: 1, line_end: 1,
      category: 'correctness', severity: 'MEDIUM', brief: 'average() off by one', confidence: 1,
      refs_json: JSON.stringify(['concept:cf_avg1']), produced_at: Date.now(), read_at: null, stale: false,
    };
    store.upsertSeed(seed);
    return store;
  }

  async function db() {
    return installShapeStub({
      concept_create_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'concept_v1' }) } }),
      conceptUsage_write: () => ({ body: { success: true, content: JSON.stringify({ id: 'usage_1' }) } }),
    });
  }

  test('an uncommitted fix leaves the finding open, records a pending fix, and credits nothing; the committed endorse closes it', async () => {
    const dir = checkout('endorse');
    const store = seeded();
    const stub = await db();
    writeFileSync(join(dir, 'stats.ts'), 'export const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;\n');

    const input = MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1', action: 'endorse' });
    const pending = await MarkComplete.handle(input, api, 's', store, dir);
    expect(pending).toContain('left open: fix pending');
    expect(pending).toContain('Commit it, then mark_complete endorse again');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    const first = stub.calls('concept_create_write').map(p => p.conceptData)[0]!;
    expect(String(first.content)).toContain('verdict: fix pending (uncommitted)');
    expect(String(first.content)).toMatch(/^fix: uncommitted$/m);
    expect(String(first.content)).toContain('fix_branch: main');
    expect(String(first.summary)).toStartWith('[verdict:pending]');
    expect(stub.calls('conceptUsage_write')).toHaveLength(0);

    git(dir, 'commit', '-qam', 'fix average');
    const sha = git(dir, 'rev-parse', 'HEAD');
    const closed = await MarkComplete.handle(input, api, 's', store, dir);
    expect(closed).toContain('endorsed (finding resolved');
    expect(closed).toContain(`fix: commit ${sha.slice(0, 10)} on main (not on any remote branch yet)`);
    expect(store.getSeedById('agf_avg1')?.stale).toBe(true);
    const second = String(stub.calls('concept_create_write').map(p => p.conceptData)[1]!.content);
    expect(second).toContain('verdict: endorsed (resolved)');
    expect(second).toContain(`fix: commit ${sha}`);
    expect(second).toContain('fix_pushed: no');
    expect(stub.calls('conceptUsage_write').map(p => p.usageData.outcome)).toEqual(['success']);
  });

  test('a fix in another file: uncommitted, pending; committed, open with the commit named; claimed with fix_commit, closed', async () => {
    const dir = checkout('endorse-other');
    const store = seeded();
    const stub = await db();
    writeFileSync(join(dir, 'util.ts'), 'export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n');
    const input = MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' });
    const pending = await MarkComplete.handle(input, api, 's', store, dir);
    expect(pending).toContain('left open: fix pending');
    expect(pending).toContain('uncommitted changes in other files. If the fix is among them, commit it');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    expect(String(stub.calls('concept_create_write')[0]!.conceptData.content)).toContain("fix_files: outside the finding's files");
    git(dir, 'commit', '-qam', 'fix sum');
    const sha = git(dir, 'rev-parse', 'HEAD');
    const named = await MarkComplete.handle(input, api, 's', store, dir);
    expect(named).toContain(`The newest commit since then is ${sha.slice(0, 10)}, touching util.ts, which is not taken as the fix on its own. No verdict was recorded.`);
    expect(named).toContain(`endorse with fix_commit: "${sha.slice(0, 10)}"`);
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    expect(stub.calls('concept_create_write')).toHaveLength(1);
    const claimed = MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1', fix_commit: sha.slice(0, 10) });
    const closed = await MarkComplete.handle(claimed, api, 's', store, dir);
    expect(closed).toContain("(named as the fix) — it touches none of the finding's files");
    expect(store.getSeedById('agf_avg1')?.stale).toBe(true);
    const content = String(stub.calls('concept_create_write')[1]!.conceptData.content);
    expect(content).toContain(`fix: commit ${sha}`);
    expect(content).toContain('fix_claimed: yes');
    expect(content).toContain('fix_touches_finding_files: no');
  });

  test('a clean file whose only commit predates the finding: nothing to endorse, no verdict, the finding stays open', async () => {
    const dir = checkout('endorse-old');
    const store = seeded();
    const stub = await db();
    const out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' }), api, 's', store, dir);
    expect(out).toContain('nothing in this checkout changed since it was recorded');
    expect(out).toContain('No verdict was recorded');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    expect(stub.calls('concept_create_write')).toHaveLength(0);
    expect(stub.calls('conceptUsage_write')).toHaveLength(0);
  });

  test('a git checkout without the finding\'s files is not where the fix is: no verdict, the finding stays open', async () => {
    const dir = checkout('endorse-absent');
    const { store } = makeTempStore('fixloc-absent-');
    store.upsertSeed({
      id: 'agf_gone1', workspace_id: 'default', file_path: 'src/nope.ts', line_start: 1, line_end: 1,
      category: 'correctness', severity: 'MEDIUM', brief: 'elsewhere', confidence: 1, refs_json: '[]',
      produced_at: Date.now(), read_at: null, stale: false,
    });
    const stub = await db();
    const out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_gone1' }), api, 's', store, dir);
    expect(out).toContain('none of its files is in this checkout');
    expect(store.getSeedById('agf_gone1')?.stale).toBe(false);
    expect(stub.calls('concept_create_write')).toHaveLength(0);
  });

  test('with a remote, an unpushed fix commit leaves the finding pending until it is pushed', async () => {
    const dir = checkout('endorse-unpushed');
    const bare = join(root, 'endorse-unpushed.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
    const store = seeded();
    const stub = await db();
    writeFileSync(join(dir, 'stats.ts'), 'fixed\n');
    git(dir, 'commit', '-qam', 'fix');
    const input = MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' });
    const unpushed = await MarkComplete.handle(input, api, 's', store, dir);
    expect(unpushed).toContain('left open: fix pending');
    expect(unpushed).toContain('is not on any remote branch, so other checkouts cannot get it');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    expect(String(stub.calls('concept_create_write')[0]!.conceptData.content)).toContain('verdict: fix pending (unpushed)');
    expect(stub.calls('conceptUsage_write')).toHaveLength(0);
    git(dir, 'push', '-q', 'origin', 'main');
    const closed = await MarkComplete.handle(input, api, 's', store, dir);
    expect(closed).toContain('endorsed (finding resolved');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(true);
  });

  /** A checkout with a bare origin, main pushed, and (unless `noHead`) origin/HEAD naming main. */
  function withOrigin(name: string, noHead = false): string {
    const dir = checkout(name);
    const bare = join(root, `${name}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
    if (!noHead) git(dir, 'remote', 'set-head', 'origin', 'main');
    return dir;
  }

  test('a fix pushed only to a task branch awaits its merge: pending, credits nothing, closes once merged', async () => {
    const dir = withOrigin('endorse-task-branch');
    const store = seeded();
    const stub = await db();
    git(dir, 'checkout', '-qb', 'task/agf_avg1');
    writeFileSync(join(dir, 'stats.ts'), 'fixed\n');
    git(dir, 'commit', '-qam', 'fix');
    git(dir, 'push', '-q', 'origin', 'task/agf_avg1');
    const input = MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' });
    const out = await MarkComplete.handle(input, api, 's', store, dir);
    expect(out).toContain('left open: fix pending');
    expect(out).toContain('only on task branches, so it is not merged into main yet');
    expect(out).toContain('relevance: not recorded until the fix is merged');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    const content = String(stub.calls('concept_create_write')[0]!.conceptData.content);
    expect(content).toContain('verdict: fix pending (awaiting merge)');
    expect(content).toContain('fix_target: main');
    expect(stub.calls('conceptUsage_write')).toHaveLength(0);

    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'task/agf_avg1');
    git(dir, 'push', '-q', 'origin', 'main');
    const closed = await MarkComplete.handle(input, api, 's', store, dir);
    expect(closed).toContain('endorsed (finding resolved');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(true);
  });

  test('a fix pushed to any other branch (a dev branch) closes as before; with no origin/HEAD the target is named generically', async () => {
    const dev = withOrigin('endorse-dev-branch');
    const store = seeded();
    await db();
    git(dev, 'checkout', '-qb', 'dev');
    writeFileSync(join(dev, 'stats.ts'), 'fixed\n');
    git(dev, 'commit', '-qam', 'fix');
    git(dev, 'push', '-q', 'origin', 'dev');
    const input = MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' });
    expect(await MarkComplete.handle(input, api, 's', store, dev)).toContain('endorsed (finding resolved');

    const bare = withOrigin('endorse-task-nohead', true);
    const store2 = seeded();
    const stub = await db();
    git(bare, 'checkout', '-qb', 'task/agf_avg1');
    writeFileSync(join(bare, 'stats.ts'), 'fixed\n');
    git(bare, 'commit', '-qam', 'fix');
    git(bare, 'push', '-q', 'origin', 'task/agf_avg1');
    expect(await MarkComplete.handle(input, api, 's', store2, bare)).toContain('not merged into its target yet');
    expect(String(stub.calls('concept_create_write')[0]!.conceptData.content)).toContain('fix_target: its target');
  });

  test('git runs in the C locale, so "not a git repository" is recognised whatever the user\'s language', () => {
    expect(GIT_ENV()).toMatchObject({ LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' });
    // With LANG set to German, git under GIT_ENV still says it in English.
    let stderr = '';
    try {
      execFileSync('git', ['-C', mkdtempSync(join(root, 'de-')), 'rev-parse', '--show-toplevel'], { env: { ...GIT_ENV(), LANG: 'de_DE.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toMatch(/not a git repository/i);
  });

  test('when git does not answer in time, nothing closes: a slow checkout never reads as "not a git checkout"', async () => {
    const dir = checkout('endorse-slow');
    writeFileSync(join(dir, 'stats.ts'), 'fixed\n');
    git(dir, 'commit', '-qam', 'fix');
    const store = seeded();
    const stub = await db();
    setFixGitTimeoutForTests(1);
    try {
      expect(fixLocation(dir, ['stats.ts'], new Date())).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('git did not answer in time') });
      const out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' }), api, 's', store, dir);
      expect(out).toContain('git did not answer in time');
      expect(out).toContain('No verdict was recorded');
    } finally {
      setFixGitTimeoutForTests(null);
    }
    expect(stub.calls('concept_create_write')).toHaveLength(0);
    expect(store.getSeedById('agf_avg1')?.stale).toBe(false);
    // Outside git, after the same calls, still "not a git checkout".
    expect(fixLocation(mkdtempSync(join(root, 'plain-')), ['stats.ts'])).toEqual({ kind: 'unknown' });
  });

  test('outside a git checkout an endorse closes the finding and says no commit is known', async () => {
    const store = seeded();
    const stub = await db();
    const out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1' }), api, 's', store, mkdtempSync(join(root, 'plain-')));
    expect(out).toContain('fix: unknown (not a git checkout)');
    expect(store.getSeedById('agf_avg1')?.stale).toBe(true);
    expect(String(stub.calls('concept_create_write')[0]!.conceptData.content)).toContain('verdict: endorsed (resolved)');
  });

  test('discard records no fix location', async () => {
    const dir = checkout('discard');
    writeFileSync(join(dir, 'stats.ts'), 'dirty\n');
    const store = seeded();
    const stub = await db();
    await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'agf_avg1', action: 'discard' }), api, 's', store, dir);
    const content = String(stub.calls('concept_create_write')[0]!.conceptData.content);
    expect(content).toContain('verdict: discarded (retracted)');
    expect(content).not.toMatch(/^fix:/m);
  });
});

describe('recall', () => {
  const FINDING = { id: 'concept:cf_avg1', summary: '[MEDIUM][correctness] kappa: average() off by one', content: 'repo: kappa\nfiles: stats.ts\nfinding_ids: agf_avg1' };
  const verdict = (v: string, tag: string, extra = '') =>
    ({ id: `concept:fv_${tag}`, summary: `[verdict:${tag}] kappa: average() off by one`, content: `finding: agf_avg1\nverdict: ${v}\n${extra}reviewed_by: metabob-mcp-other` });

  async function recall(verdicts: Array<Record<string, unknown>>, workspace: string) {
    await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [FINDING] : verdicts } }),
    });
    return fetchAgentFindings(api, { repo: 'kappa', workspace });
  }

  test('a pending fix keeps the finding open and says it is uncommitted elsewhere', async () => {
    const r = await recall([verdict('fix pending (uncommitted)', 'pending', 'fix: uncommitted\nfix_branch: main\n')], checkout('r-pending'));
    expect(r.findings[0]!.verdict).toBeUndefined();
    expect(r.findings[0]!.pending).toEqual({ by: 'metabob-mcp-other', branch: 'main', here: false });
    const text = renderFindingsSection(r, { max: 10 });
    expect(text).toContain('[fix pending: uncommitted in another checkout (metabob-mcp-other) on main; not in this one]');
    expect(text).not.toContain('Closed findings');
  });

  test('a fix commit this checkout lacks closes the finding and says the fix is not in HEAD; a committed fix wins over a pending one', async () => {
    const r = await recall([
      verdict('fix pending (uncommitted)', 'pending', 'fix: uncommitted\n'),
      verdict('endorsed (resolved)', 'endorse', 'fix: commit 0123456789abcdef0123456789abcdef01234567\nfix_branch: fix-avg\nfix_pushed: no\n'),
    ], checkout('r-fixed'));
    expect(r.findings[0]!.verdict).toBe('fixed');
    expect(r.findings[0]!.fix).toEqual({ sha: '0123456789abcdef0123456789abcdef01234567', branch: 'fix-avg', pushed: false, inHead: false });
    expect(renderFindingsSection(r, { max: 10 })).toContain(
      "[FIXED in 0123456789] [MEDIUM][correctness] kappa: average() off by one (concept: cf_avg1) — the fix is not in this checkout's HEAD (fixed on fix-avg, not pushed when endorsed)");
  });

  test('a fix commit in this checkout\'s HEAD renders as plain FIXED in <sha>', async () => {
    const dir = checkout('r-here');
    const sha = git(dir, 'rev-parse', 'HEAD');
    const r = await recall([verdict('endorsed (resolved)', 'endorse', `fix: commit ${sha}\n`)], dir);
    const text = renderFindingsSection(r, { max: 10 });
    expect(text).toContain(`[FIXED in ${sha.slice(0, 10)}]`);
    expect(text).not.toContain('not in this checkout');
  });

  test('an unpushed pending fix says so in recall', async () => {
    const r = await recall([verdict('fix pending (unpushed)', 'pending', 'fix: commit 0123456789abcdef0123456789abcdef01234567\nfix_branch: main\nfix_pushed: no\n')], checkout('r-unpushed'));
    expect(r.findings[0]!.verdict).toBeUndefined();
    expect(renderFindingsSection(r, { max: 10 })).toContain('[fix pending: committed in another checkout (metabob-mcp-other) on main but not pushed; not available here]');
  });

  test('a pending verdict reads as no verdict to a reader that knows only endorsed and discarded', () => {
    const content = 'finding: agf_avg1\nverdict: fix pending (uncommitted)';
    expect(/^verdict:\s*(endorsed|discarded)/m.test(content)).toBe(false);
    expect('[verdict:pending] kappa: x'.includes('[verdict:endorse]')).toBe(false);
    expect(parseVerdictConcept(content, '')?.verdict).toBe('pending');
  });
});
