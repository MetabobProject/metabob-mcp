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
    expect(repoAliases(l.superWs)).toEqual({ kind: 'super', vessels: new Set(['development-vessel']) });
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
