/**
 * One file, one ledger (SPEC §repository-identity): the substrate's super-repo and a vessel's own checkout name the
 * same file under two repositories and two paths (`repos/<vessel>/src/x.ts` there, `src/x.ts` here). Recall in either
 * reads both, with the paths mapped, so neither side believes it has the full picture while holding half.
 * Findings recorded before this, under either identity, are found from both sides: nothing to migrate.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAttachment } from '../../src/attachment';
import { clearRepoIdentityCache, normalizeRemoteUrl, repoAliases, repoIdentity } from '../../src/repo-identity';
import { fetchAgentFindings } from '../../src/tools/_findings';
import { installShapeStub } from '../helpers/shape-stub';

const root = mkdtempSync(join(tmpdir(), 'metabob-supervessel-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  setAttachment(null);
  clearRepoIdentityCache();
});

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });

/** A super-repo checkout with repos/development-vessel, and a separate checkout of the vessel, each with its origin. */
let n = 0;
function layout() {
  const base = join(root, `l${n++}`);
  const superWs = join(base, 'substrate');
  const vesselWs = join(base, 'development-vessel');
  for (const [dir, origin] of [[superWs, join(base, 'substrate.git')], [vesselWs, join(base, 'development-vessel.git')]] as const) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
    git(dir, 'remote', 'add', 'origin', origin);
  }
  mkdirSync(join(superWs, 'repos', 'development-vessel', 'src'), { recursive: true });
  writeFileSync(join(superWs, 'repos', 'development-vessel', 'src', 'x.ts'), 'x\n');
  mkdirSync(join(vesselWs, 'src'), { recursive: true });
  writeFileSync(join(vesselWs, 'src', 'x.ts'), 'x\n');
  return { superWs, vesselWs, superId: normalizeRemoteUrl(join(base, 'substrate.git'))!, vesselId: normalizeRemoteUrl(join(base, 'development-vessel.git'))! };
}

async function ledger(rows: Array<{ id: string; repo: string; files: string; summary: string }>) {
  await installShapeStub({
    conceptSearch: (p) => ({
      body: {
        content: p.shape === 'code_finding'
          ? rows.map(r => ({ id: `concept:${r.id}`, shape: 'code_finding', summary: `[MEDIUM][correctness] x: ${r.summary}`, content: `repo: ${r.repo}\nfiles: ${r.files}\ncategory: correctness\nfinding_ids: agf_${r.id}` }))
          : [],
      },
    }),
  });
}

describe('one ledger for a super-repo and a vessel checkout', () => {
  test('repoAliases: the super-repo lists its vessels; a vessel checkout names its prefix', () => {
    const l = layout();
    expect(repoAliases(l.superWs)).toEqual({ kind: 'super', vessels: new Map([['development-vessel', null]]) });
    expect(repoAliases(l.vesselWs)).toEqual({ kind: 'vessel', name: 'development-vessel', prefix: 'repos/development-vessel' });
  });

  test('each side recalls both findings on the same file, in its own path form; an unrelated one stays out', async () => {
    const l = layout();
    await ledger([
      { id: 'c_super', repo: l.superId, files: 'repos/development-vessel/src/x.ts', summary: 'recorded in the super-repo' },
      { id: 'c_vessel', repo: l.vesselId, files: 'src/x.ts', summary: 'recorded in the vessel checkout' },
      { id: 'c_other', repo: 'github.com/someone/else', files: 'src/x.ts', summary: 'another repository' },
      { id: 'c_super_other_vessel', repo: l.superId, files: 'repos/activity-api/src/y.ts', summary: 'another vessel in the super-repo' },
    ]);
    const fromSuper = await fetchAgentFindings({} as never, { repo: repoIdentity(l.superWs), workspace: l.superWs, filePath: 'repos/development-vessel/src/x.ts' });
    expect(fromSuper.findings.map(f => f.id).sort()).toEqual(['c_super', 'c_vessel']);
    expect(fromSuper.findings.find(f => f.id === 'c_vessel')!.files).toEqual(['repos/development-vessel/src/x.ts']);

    const fromVessel = await fetchAgentFindings({} as never, { repo: repoIdentity(l.vesselWs), workspace: l.vesselWs, filePath: 'src/x.ts' });
    expect(fromVessel.findings.map(f => f.id).sort()).toEqual(['c_super', 'c_vessel']);
    expect(fromVessel.findings.find(f => f.id === 'c_super')!.files).toEqual(['src/x.ts']);

    // Without a file filter the vessel sees the super-repo's findings on its own files only, never another vessel's.
    const allVessel = await fetchAgentFindings({} as never, { repo: repoIdentity(l.vesselWs), workspace: l.vesselWs });
    expect(allVessel.findings.map(f => f.id).sort()).toEqual(['c_super', 'c_vessel']);
  });

  test('a plain repository (no repos/, no super-repo) recalls only its own ledger, as before', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    execFileSync('git', ['init', '-q', plain]);
    git(plain, 'remote', 'add', 'origin', 'git@github.com:org/plain.git');
    await ledger([
      { id: 'c_own', repo: 'github.com/org/plain', files: 'src/a.ts', summary: 'own' },
      { id: 'c_super_style', repo: 'github.com/org/substrate', files: 'repos/other/src/a.ts', summary: 'a super-repo of another vessel' },
    ]);
    const r = await fetchAgentFindings({} as never, { repo: repoIdentity(plain), workspace: plain });
    expect(r.findings.map(f => f.id)).toEqual(['c_own']);
  });
});

describe('closing across a super-repo and a vessel checkout', () => {
  const gitc = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  const OLD = new Date(Date.now() - 3_600_000).toISOString();

  /** A checkout of `file` with a bare origin, committed an hour ago and pushed. */
  function checkout(name: string, file: string) {
    const base = join(root, `c-${name}`);
    const bare = join(base, `${name}.git`);
    const ws = join(base, name);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', ws]);
    gitc(ws, 'remote', 'add', 'origin', bare);
    mkdirSync(join(ws, file, '..'), { recursive: true });
    writeFileSync(join(ws, file), 'bug\n');
    gitc(ws, 'add', '.');
    execFileSync('git', ['-C', ws, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { env: { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD } });
    gitc(ws, 'push', '-q', 'origin', 'main');
    return { ws, id: normalizeRemoteUrl(bare)! };
  }

  async function concept(repo: string, files: string) {
    const rows: Array<Record<string, unknown>> = [];
    const root = { id: 'concept:concept_x', shape: 'code_finding', summary: '[MEDIUM][correctness] r: bug', created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      content: `repo: ${repo}\nfiles: ${files}\ncategory: correctness\nfinding_ids: agf_x` };
    const stub = await installShapeStub({
      conceptGraph: (p) => (p.concept_id === 'concept_x' ? { body: { content: { root, edges: [] } } } : { status: 404, body: { error: 'Concept not found' } }),
      conceptSearch: () => ({ body: { content: rows } }),
      concept_create_write: (p) => { rows.push(p.conceptData); return { body: { success: true, content: JSON.stringify({ id: 'v1' }) } }; },
      conceptUsage_write: () => ({ body: { success: true, content: '{}' } }),
    });
    return stub;
  }

  test('a finding recorded in the super-repo closes from the vessel checkout after a pushed fix, and the reverse', async () => {
    const MarkComplete = await import('../../src/tools/mark-complete');
    // Recorded in the super-repo, fixed in the vessel checkout.
    const vessel = checkout('development-vessel', 'src/x.ts');
    let stub = await concept('github.com/avigopal/substrate', 'repos/development-vessel/src/x.ts');
    writeFileSync(join(vessel.ws, 'src/x.ts'), 'fixed\n');
    gitc(vessel.ws, 'commit', '-qam', 'fix');
    gitc(vessel.ws, 'push', '-q', 'origin', 'main');
    let out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'concept_x' }), {} as never, 's', null, vessel.ws);
    expect(out).toContain('endorsed');
    expect(out).not.toContain('none of its files is in this checkout');
    expect(String(stub.calls('concept_create_write')[0]!.conceptData.content)).toContain('verdict: endorsed (resolved)');
    setAttachment(null);
    clearRepoIdentityCache();

    // Recorded in the vessel checkout, fixed in the super-repo.
    const sup = checkout('substrate', 'repos/development-vessel/src/x.ts');
    stub = await concept('github.com/avigopal/development-vessel', 'src/x.ts');
    writeFileSync(join(sup.ws, 'repos/development-vessel/src/x.ts'), 'fixed\n');
    gitc(sup.ws, 'commit', '-qam', 'fix');
    gitc(sup.ws, 'push', '-q', 'origin', 'main');
    out = await MarkComplete.handle(MarkComplete.InputSchema.parse({ problem_id: 'concept_x' }), {} as never, 's', null, sup.ws);
    expect(out).toContain('endorsed');
    expect(String(stub.calls('concept_create_write')[0]!.conceptData.content)).toContain('verdict: endorsed (resolved)');
  });

  test('finding close from the vessel checkout: the awaiting-merge verdict names the finding\'s own repo and files', async () => {
    const { closeFromCommits } = await import('../../src/finding-close');
    const vessel = checkout('dv-close', 'src/x.ts');
    const base = execFileSync('git', ['-C', vessel.ws, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const finding = { id: 'concept:concept_y', shape: 'code_finding', summary: '[MEDIUM][correctness] r: bug', created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      content: 'repo: github.com/avigopal/substrate\nfiles: repos/dv-close/src/x.ts\ncategory: correctness\nfinding_ids: agf_y' };
    const written: Array<Record<string, unknown>> = [];
    await installShapeStub({
      conceptSearch: (p) => ({ body: { content: p.shape === 'code_finding' ? [finding] : [] } }),
      concept_create_write: (p) => { written.push(p.conceptData); return { body: { success: true, content: JSON.stringify({ id: 'v1' }) } }; },
    });
    gitc(vessel.ws, 'checkout', '-qb', 'task/agf_y');
    writeFileSync(join(vessel.ws, 'src/x.ts'), 'fixed\n');
    gitc(vessel.ws, 'commit', '-qam', 'fix\n\nFixes-Finding: agf_y');
    gitc(vessel.ws, 'push', '-q', 'origin', 'task/agf_y');
    const out = await closeFromCommits({ commits: `${base}..HEAD`, target: 'main', workDir: vessel.ws, json: false }, 's');
    expect(out.reports[0]!.outcome).toBe('awaiting_merge');
    const content = String(written[0]!.content);
    expect(content).toContain('repo: github.com/avigopal/substrate\n');
    expect(content).toContain('files: repos/dv-close/src/x.ts\n');
    expect(content).not.toContain(`repo: ${vessel.id}`);
  });

  test('a vessel directory with its own origin is matched by that exact identity, not by name', async () => {
    const sup = join(root, 'super-exact');
    mkdirSync(join(sup, 'repos', 'api'), { recursive: true });
    execFileSync('git', ['init', '-q', sup]);
    git(sup, 'remote', 'add', 'origin', 'git@github.com:org/substrate.git');
    execFileSync('git', ['init', '-q', join(sup, 'repos', 'api')]);
    git(join(sup, 'repos', 'api'), 'remote', 'add', 'origin', 'git@github.com:org/api.git');
    expect(repoAliases(sup)).toEqual({ kind: 'super', vessels: new Map([['api', 'github.com/org/api']]) });
    await ledger([
      { id: 'c_ours', repo: 'github.com/org/api', files: 'src/a.ts', summary: 'this super-repo\'s api' },
      { id: 'c_other_api', repo: 'github.com/someone/api', files: 'src/a.ts', summary: 'an unrelated repo also called api' },
    ]);
    const r = await fetchAgentFindings({} as never, { repo: repoIdentity(sup), workspace: sup });
    expect(r.findings.map(f => f.id)).toEqual(['c_ours']);
    expect(r.findings[0]!.files).toEqual(['repos/api/src/a.ts']);
  });
});
