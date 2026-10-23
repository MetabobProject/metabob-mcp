/**
 * Close by commit (SPEC §finding-close): after a push, a commit's `Fixes-Finding:` trailer closes its finding once
 * the fix is merged into the target on the origin, and never before, never for another repository's finding,
 * never over a revert, and never from a stale view of the origin.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAttachment } from '../../src/attachment';
import { clearRepoIdentityCache, normalizeRemoteUrl } from '../../src/repo-identity';
import { setResolverIdentity } from '../../src/resolver-identity';
import { closeFromCommits, trailerIds } from '../../src/finding-close';
import { fetchAgentFindings, renderFindingsSection } from '../../src/tools/_findings';
import { installShapeStub } from '../helpers/shape-stub';

const root = mkdtempSync(join(tmpdir(), 'metabob-close-'));
beforeAll(() => setResolverIdentity({ vesselId: 'metabob-mcp-cell1' }));
afterAll(() => {
  setResolverIdentity({ vesselId: undefined });
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  setAttachment(null);
  clearRepoIdentityCache();
});

const git = (dir: string, ...a: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();

/** A bare origin seeded on main an hour ago, and a clone of it: the cell's /work. */
function repo(name: string) {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
  writeFileSync(join(work, 'stats.ts'), 'export const average = (xs: number[]) => xs.length;\n');
  writeFileSync(join(work, 'util.ts'), 'export const sum = 0;\n');
  const old = new Date(Date.now() - 3_600_000).toISOString();
  execFileSync('git', ['-C', work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'checkout', '-q', '-b', 'main'], { stdio: 'ignore' });
  git(work, 'add', '.');
  execFileSync('git', ['-C', work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  git(work, 'push', '-q', 'origin', 'main');
  return { bare, work, base: git(work, 'rev-parse', 'HEAD'), repoId: normalizeRemoteUrl(bare)! };
}

/** concept-db with one open finding on stats.ts, recorded 30 minutes ago, keeping what is written. */
async function ledger(repoId: string, id = 'agf_avg1') {
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  const rows: Array<Record<string, unknown>> = [{
    id: `concept:concept_${id}`, shape: 'code_finding', created_at: at, summary: '[MEDIUM][correctness] r: average() off by one',
    content: `repo: ${repoId}\nfiles: stats.ts\ncategory: correctness\nfinding_ids: ${id}\nrecorded_by: someone`,
  }];
  let n = 0;
  await installShapeStub({
    conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape) } }),
    conceptGraph: (p) => {
      const r = rows.find(x => String(x.id) === `concept:${p.concept_id}`);
      return r ? { body: { content: { root: r, edges: [] } } } : { status: 404, body: { error: 'Concept not found' } };
    },
    concept_create_write: (p) => {
      n++;
      const cid = `v${String(n).padStart(3, '0')}`;
      rows.push({ id: `concept:${cid}`, shape: p.conceptData.shape, summary: p.conceptData.summary, content: p.conceptData.content, created_at: new Date().toISOString() });
      return { body: { success: true, content: JSON.stringify({ id: cid }) } };
    },
    conceptUsage_write: () => ({ body: { success: true, content: '{}' } }),
  });
  return rows;
}

const verdicts = (rows: Array<Record<string, unknown>>) => rows.filter(r => r.shape === 'finding_verdict').map(r => String(r.content));
const close = (work: string, commits: string, target = 'main') => closeFromCommits({ commits, target, workDir: work, json: false }, 'sess');

describe('trailerIds', () => {
  test('reads Fixes-Finding trailers, several per commit, and ignores the body', () => {
    const r = repo('trailers');
    writeFileSync(join(r.work, 'stats.ts'), 'x\n');
    git(r.work, 'commit', '-qam', 'fix\n\nFixes-Finding: agf_body is prose here, not a trailer\n\nFixes-Finding: agf_a\nFixes-Finding: agf_b');
    expect(trailerIds(r.work, 'HEAD')).toEqual(['agf_a', 'agf_b']);
  });
});

describe('closeFromCommits', () => {
  test('a fix pushed to the target closes its finding, naming the commit as an explicit claim', async () => {
    const r = repo('merged');
    const rows = await ledger(r.repoId);
    writeFileSync(join(r.work, 'stats.ts'), 'fixed\n');
    git(r.work, 'commit', '-qam', 'fix average\n\nFixes-Finding: agf_avg1');
    git(r.work, 'push', '-q', 'origin', 'main');
    const sha = git(r.work, 'rev-parse', 'HEAD');
    const out = await close(r.work, `${r.base}..HEAD`);
    expect(out.reports).toMatchObject([{ id: 'agf_avg1', outcome: 'closed', commit: sha }]);
    const v = verdicts(rows)[0]!;
    expect(v).toContain('verdict: endorsed (resolved)');
    expect(v).toContain(`fix: commit ${sha}`);
    expect(v).toContain('fix_claimed: yes');
    expect(v).toContain('fix_via: trailer');
    // No commit text is sent: neither the subject nor the message body.
    expect(v).not.toContain('fix average');
  });

  test('a squash merge into the target, with the trailers in its body, closes the finding with the squash commit', async () => {
    const r = repo('squash');
    const rows = await ledger(r.repoId);
    git(r.work, 'checkout', '-qb', 'task/agf_avg1');
    writeFileSync(join(r.work, 'stats.ts'), 'step 1\n');
    git(r.work, 'commit', '-qam', 'step 1\n\nFixes-Finding: agf_avg1');
    writeFileSync(join(r.work, 'stats.ts'), 'step 2\n');
    git(r.work, 'commit', '-qam', 'step 2');
    git(r.work, 'push', '-q', 'origin', 'task/agf_avg1');
    // The reviewer squashes onto main: GitHub-style, the messages are concatenated into the body.
    const reviewer = join(root, 'squash-reviewer');
    execFileSync('git', ['clone', '-q', r.bare, reviewer], { stdio: 'ignore' });
    git(reviewer, 'merge', '-q', '--squash', 'origin/task/agf_avg1');
    git(reviewer, 'commit', '-qm', 'Fix average (#12)\n\n* step 1\n\nFixes-Finding: agf_avg1\n\n* step 2\n\nReviewed-by: someone');
    git(reviewer, 'push', '-q', 'origin', 'main');
    const squash = git(reviewer, 'rev-parse', 'HEAD');
    const out = await close(r.work, `${r.base}..task/agf_avg1`);
    expect(out.reports).toMatchObject([{ id: 'agf_avg1', outcome: 'closed', commit: squash }]);
    expect(verdicts(rows)[0]).toContain(`fix: commit ${squash}`);
  });

  test('pushed to a task branch and not merged: fix pending (awaiting merge), shown so in recall', async () => {
    const r = repo('awaiting');
    const rows = await ledger(r.repoId);
    git(r.work, 'checkout', '-qb', 'task/agf_avg1');
    writeFileSync(join(r.work, 'stats.ts'), 'fixed\n');
    git(r.work, 'commit', '-qam', 'fix\n\nFixes-Finding: agf_avg1');
    git(r.work, 'push', '-q', 'origin', 'task/agf_avg1');
    const out = await close(r.work, `${r.base}..HEAD`);
    expect(out.reports[0]!.outcome).toBe('awaiting_merge');
    expect(verdicts(rows)[0]).toContain('verdict: fix pending (awaiting merge)');
    const recalled = await fetchAgentFindings({} as never, { repo: { id: r.repoId, name: 'r', source: 'origin' } });
    expect(recalled.findings[0]!.verdict).toBeUndefined();
    expect(renderFindingsSection(recalled, { max: 10 })).toContain('[fix pending: pushed by metabob-mcp-cell1, awaiting merge into main]');
  });

  test('unpushed, reverted, another repository\'s id and a closed finding write nothing', async () => {
    const r = repo('nothing');
    const rows = await ledger(r.repoId);
    writeFileSync(join(r.work, 'stats.ts'), 'fixed\n');
    git(r.work, 'commit', '-qam', 'fix\n\nFixes-Finding: agf_avg1\nFixes-Finding: agf_elsewhere');
    let out = await close(r.work, `${r.base}..HEAD`);
    expect(out.reports.map(x => [x.id, x.outcome])).toEqual([['agf_avg1', 'unpushed'], ['agf_elsewhere', 'unknown']]);
    expect(verdicts(rows)).toHaveLength(0);
    // Pushed, then reverted on the target.
    git(r.work, 'push', '-q', 'origin', 'main');
    const fix = git(r.work, 'rev-parse', 'HEAD');
    git(r.work, 'revert', '--no-edit', fix);
    git(r.work, 'push', '-q', 'origin', 'main');
    out = await close(r.work, `${r.base}..${fix}`);
    expect(out.reports.find(x => x.id === 'agf_avg1')!.outcome).toBe('reverted');
    expect(verdicts(rows)).toHaveLength(0);
  });

  test('after a rebase, the cell\'s own commits list keeps other cells\' trailers out of its close', async () => {
    const r = repo('rebase');
    const rows = await ledger(r.repoId, 'agf_mine');
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    rows.push({ id: 'concept:concept_agf_theirs', shape: 'code_finding', created_at: at, summary: '[LOW][correctness] r: sum() wrong',
      content: `repo: ${r.repoId}\nfiles: util.ts\ncategory: correctness\nfinding_ids: agf_theirs\nrecorded_by: someone` });
    // Cell B fixes its finding and merges first.
    const b = join(root, 'rebase-b');
    execFileSync('git', ['clone', '-q', r.bare, b], { stdio: 'ignore' });
    writeFileSync(join(b, 'util.ts'), 'export const sum = 1;\n');
    git(b, 'commit', '-qam', 'fix sum\n\nFixes-Finding: agf_theirs');
    git(b, 'push', '-q', 'origin', 'main');
    // Cell A fixes its own, then fetches and rebases onto B's work, as the task's integration policy says, and lists its own commits before pushing.
    writeFileSync(join(r.work, 'stats.ts'), 'fixed\n');
    git(r.work, 'commit', '-qam', 'fix average\n\nFixes-Finding: agf_mine');
    git(r.work, 'fetch', '-q', 'origin');
    git(r.work, 'rebase', '-q', 'origin/main');
    const own = git(r.work, 'rev-list', '--reverse', 'origin/main..HEAD').split('\n').filter(Boolean);
    git(r.work, 'push', '-q', 'origin', 'main');
    // base..HEAD would now hold B's commit too.
    expect(git(r.work, 'rev-list', `${r.base}..HEAD`).split('\n')).toHaveLength(2);
    const out = await closeFromCommits({ commits: own, target: 'main', workDir: r.work, json: false }, 'sess');
    expect(out.reports.map(x => [x.id, x.outcome])).toEqual([['agf_mine', 'closed']]);
    expect(verdicts(rows).some(v => v.includes('finding: agf_theirs'))).toBe(false);
  });

  test('a merged fix closes even with leftover edits in the work tree: the claim is judged on the target', async () => {
    const r = repo('dirty');
    const rows = await ledger(r.repoId);
    writeFileSync(join(r.work, 'stats.ts'), 'fixed\n');
    git(r.work, 'commit', '-qam', 'fix\n\nFixes-Finding: agf_avg1');
    git(r.work, 'push', '-q', 'origin', 'main');
    writeFileSync(join(r.work, 'stats.ts'), 'a later, unrelated edit\n');
    const out = await close(r.work, `${r.base}..HEAD`);
    expect(out.reports[0]!.outcome).toBe('closed');
    expect(verdicts(rows)[0]).toContain('verdict: endorsed (resolved)');
  });

  test('a failed fetch writes nothing', async () => {
    const r = repo('nofetch');
    const rows = await ledger(r.repoId);
    writeFileSync(join(r.work, 'stats.ts'), 'fixed\n');
    git(r.work, 'commit', '-qam', 'fix\n\nFixes-Finding: agf_avg1');
    git(r.work, 'push', '-q', 'origin', 'main');
    rmSync(r.bare, { recursive: true, force: true });
    const out = await close(r.work, `${r.base}..HEAD`);
    expect(out.code).toBe(1);
    expect(out.message).toContain('git fetch origin main failed, so nothing was written');
    expect(verdicts(rows)).toHaveLength(0);
  });
});
