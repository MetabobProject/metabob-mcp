// doclinks: ignore-citations — the fixtures below cite docs that exist only in temp repos.
//
// DOCLINKS — the gate for the docs ↔ code link database (scripts/doclinks.mjs, docs/links.json).
//
// FAILS on (errors): a live doc citing a file that does not exist; an `@anchor` that does not resolve
// or is ambiguous; a commit pin whose commit or line does not exist; a bare `file:line` in a live doc;
// a broken relative link; code citing an unregistered doc name or a section the doc does not have; a
// `covers` glob or registry entry matching nothing. WARNS on drift: anchored code changed since the
// last build; `derived` stale; a doc older than the code it covers.
//
// Every error class fires on a fixture and stays quiet on its legitimate twin; the real tree is shown
// to be clean AND to have been scanned; two mutants (a citation injected into a real live doc, and a
// scanner that has lost TypeScript) must each turn the result red.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as doclinks from '../../scripts/doclinks.mjs';

const { gitRepo, loadDb, build, check, impacted, resolveAnchor, sectionAt, sectionPathAt, scanCodeForDocs, slug, symbolRegions, ROOT } = doclinks as any;
const SCRIPT = join(ROOT, 'scripts', 'doclinks.mjs');

type Files = Record<string, string>;
const fixture = (files: Files, pins: Record<string, number> = {}) => ({
  root: join(tmpdir(), 'doclinks-nonexistent-fixture'), files: Object.keys(files),
  read: (f: string) => files[f] ?? null,
  linesAt: (sha: string, f: string) => pins[`${sha}:${f}`] ?? null,
  lastCommitTime: () => 0,
});
const baseDb = (): any => ({
  curated: { docs: { SPEC: 'docs/SPEC.md' }, live: ['docs/SPEC.md', 'docs/live/'], covers: {}, retired: {}, outsideTree: {}, notDocs: [], notCode: [] },
  derived: {},
});
const CODE = 'src/x.ts';
const code = [
  '// Contract: SPEC §get_x',
  'export async function handle(input: Input): Promise<string> {',
  '  return run(input);',
  '}',
  '// @anchor the-door',
  'export const door = openDoor();',
  '// @anchor twice', 'a();', '// @anchor twice', 'b();',
].join('\n');
const SPEC = '# Spec\n\n## Tools\n\n### get_x\n\nHandler: `src/x.ts@handle`\n\n### get_y\n\nOther text about get_y.\n\n## Impulse shapes (HTTP resolver)\n\nTable.\n';
const errsOf = (docText: string, extra: Files = {}, dbMut = (d: any) => d, pins: Record<string, number> = {}) => {
  const repo = fixture({ [CODE]: code, 'docs/SPEC.md': SPEC, 'docs/live/a.md': docText, ...extra }, pins);
  const d = dbMut(baseDb()); d.derived = build(repo, d);
  return check(repo, d).errors as string[];
};

describe('doclinks: the real tree', () => {
  const real = gitRepo();
  const db = loadDb(real);
  const r = check(real, db);

  test('the scan walked the tree — a clean result over nothing is not a result', () => {
    expect(r.stats.liveDocs).toBeGreaterThanOrEqual(8);
    expect(r.stats.codeFilesCiting).toBeGreaterThanOrEqual(28);   // every registered tool cites its SPEC section
    expect(r.stats.anchors).toBeGreaterThanOrEqual(40);           // every SPEC tool section names its handler
  });

  test('has 0 broken citations', () => {
    expect(r.errors).toEqual([]);
  });

  test('MUTANT: one bare line citation injected into a real live doc is exactly one new error', () => {
    const target = 'docs/SPEC.md';
    const bent = { ...real, read: (f: string) => f === target ? real.read(f) + '\n\nsee `src/config.ts:12`\n' : real.read(f) };
    const after = check(bent, db).errors as string[];
    expect(after.length).toBe(r.errors.length + 1);
    expect(after.some(e => e.startsWith(target) && /bare line citation/.test(e))).toBe(true);
  });

  test('MUTANT: a scanner that has lost TypeScript fails the scan-ran guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doclinks-mutant-'));
    try {
      const text = readFileSync(SCRIPT, 'utf8');
      const mutant = text.replace("const CODE_EXTS = ['tsx', 'ts', 'mts', 'cts', ", 'const CODE_EXTS = [');
      expect(mutant).not.toBe(text);                               // the mutation point exists
      const path = join(dir, 'doclinks-mutant.mjs');
      writeFileSync(path, mutant);
      const m: any = await import(pathToFileURL(path).href);
      const s = m.check(m.gitRepo(ROOT), db).stats;
      expect(s.codeFilesCiting < 28 || s.anchors < 40).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // A second full scan of the real tree, in a freshly imported module: ~3 s on a Windows runner.
  }, 30_000);
});

describe('doclinks: every error class fires, and its legitimate twin does not', () => {
  test('twin: an existing file, a marker anchor, a declaration anchor and a cited section are clean', () => {
    expect(errsOf('see `src/x.ts` and `src/x.ts@the-door` and `src/x.ts@handle`')).toEqual([]);
  });
  test('a live doc citing a missing file — and its retired / outside-tree twins', () => {
    expect(errsOf('see `src/gone.ts`').some(e => /src\/gone\.ts, which does not exist/.test(e))).toBe(true);
    expect(errsOf('see `src/gone.ts`', {}, d => (d.curated.retired['src/gone.ts'] = 'deleted on purpose', d))).toEqual([]);
    expect(errsOf('see `dist/cli.js`', {}, d => (d.curated.outsideTree['dist/**'] = 'build output', d))).toEqual([]);
    expect(errsOf('runs on Node.js', {}, d => (d.curated.notCode.push('Node.js'), d))).toEqual([]);
    expect(errsOf('unit tests are `tests/unit/*.test.ts` and `*.spec.ts`')).toEqual([]);   // a glob is not a citation
  });
  test('a bare `file:line` in a live doc — and the same line in a record doc', () => {
    expect(errsOf('see `src/x.ts:3`').some(e => /bare line citation/.test(e))).toBe(true);
    expect(errsOf('ok', { 'docs/history/h.md': 'see `src/x.ts:3`' })).toEqual([]);
  });
  test('an anchor that does not resolve, and a marker that is not unique', () => {
    expect(errsOf('see `src/x.ts@nope`').some(e => /does not resolve/.test(e))).toBe(true);
    expect(errsOf('see `src/x.ts@twice`').some(e => /appears 2 times/.test(e))).toBe(true);
  });
  test('an anchor cited by an ambiguous basename — and the same anchor by path', () => {
    const extra = { 'src/tools/x.ts': 'export function other() {}\n' };
    expect(errsOf('see `x.ts@handle`', extra).some(e => /ambiguous/.test(e))).toBe(true);
    expect(errsOf('see `src/x.ts@handle`', extra)).toEqual([]);
  });
  test('commit pins: a good pin is clean; a missing file or a line past the end fires', () => {
    expect(errsOf('see `src/x.ts:3@abc1234`', {}, d => d, { 'abc1234:src/x.ts': 10 })).toEqual([]);
    expect(errsOf('see `src/x.ts:3@abc1234`').some(e => /does not exist at abc1234/.test(e))).toBe(true);
    expect(errsOf('see `src/x.ts:30@abc1234`', {}, d => d, { 'abc1234:src/x.ts': 10 }).some(e => /only 10 lines/.test(e))).toBe(true);
  });
  test('a broken relative link', () => {
    expect(errsOf('[x](../nowhere.md)').some(e => /link to \.\.\/nowhere\.md is broken/.test(e))).toBe(true);
    expect(errsOf('[spec](../SPEC.md)')).toEqual([]);
  });
  test('code citing an unregistered doc name — and its notDocs twin', () => {
    expect(errsOf('ok', { 'src/y.ts': '// see GHOST §tools' }).some(e => /GHOST, which is not a registered doc/.test(e))).toBe(true);
    expect(errsOf('ok', { 'src/y.ts': '// see GHOST §tools' }, d => (d.curated.notDocs.push('GHOST'), d))).toEqual([]);
  });
  test('code citing a section the doc does not have — and a real one', () => {
    expect(errsOf('ok', { 'src/y.ts': '// SPEC §get_z' }).some(e => /SPEC §get_z, which is not a section/.test(e))).toBe(true);
    expect(errsOf('ok', { 'src/y.ts': '// SPEC §get_y and SPEC §impulse-shapes' })).toEqual([]);
  });
  test('a file carrying the ignore pragma is not scanned for citations', () => {
    expect(errsOf('ok', { 'src/y.ts': '// doclinks: ignore-citations\n// GHOST §x SPEC §nope' })).toEqual([]);
  });
  test('a covers glob that matches nothing, and a registry entry pointing at no file', () => {
    expect(errsOf('ok', {}, d => (d.curated.covers['docs/live/a.md'] = ['nothing/*.ts'], d)).some(e => /matches no file/.test(e))).toBe(true);
    expect(errsOf('ok', {}, d => (d.curated.docs.GHOST = 'docs/ghost.md', d)).some(e => /maps "GHOST"/.test(e))).toBe(true);
  });
});

describe('doclinks: drift warns, never fails', () => {
  test('the anchored line changing is a warning naming the citation', () => {
    const files = { [CODE]: code, 'docs/SPEC.md': SPEC, 'docs/live/a.md': 'see `src/x.ts@the-door`' };
    const d = baseDb(); d.derived = build(fixture(files), d);
    const c = check(fixture({ ...files, [CODE]: code.replace('openDoor()', 'openDoor(true)') }), d);
    expect(c.errors).toEqual([]);
    expect(c.warnings.some((w: string) => /code under `src\/x\.ts@the-door` changed/.test(w))).toBe(true);
  });
  test('a doc older than the code it covers warns; a later review clears it; an earlier one does not', () => {
    const files = { [CODE]: code, 'docs/SPEC.md': SPEC, 'docs/live/a.md': 'covers x' };
    const times: Record<string, number> = { 'docs/live/a.md': 100, [CODE]: 200 };
    const repo = { ...fixture(files), lastCommitTime: (f: string) => times[f] || 0, commitTime: (sha: string) => ({ rev250: 250, rev150: 150 } as any)[sha] || 0 };
    const d = baseDb(); d.curated.covers['docs/live/a.md'] = [CODE]; d.derived = build(repo, d);
    const older = (w: string[]) => w.some(x => /older than 1 file/.test(x));
    expect(older(check(repo, d).warnings)).toBe(true);
    d.curated.reviewed = { 'docs/live/a.md': { at: 'rev250', why: 'checked' } };
    expect(older(check(repo, d).warnings)).toBe(false);
    d.curated.reviewed['docs/live/a.md'].at = 'rev150';
    expect(older(check(repo, d).warnings)).toBe(true);
  });
});

describe('doclinks: sections, anchors and symbols in TypeScript', () => {
  test('one slug rule for headings and citations', () => {
    expect(slug('Impulse shapes (HTTP resolver)')).toBe('impulse-shapes');
    expect(slug('`get_problems`')).toBe('get_problems');
    expect(slug('Docs ↔ code links')).toBe('docs-code-links');
    expect(sectionAt(SPEC, SPEC.split('\n').indexOf('Handler: `src/x.ts@handle`') + 1)).toBe('get_x');
    expect(sectionPathAt(SPEC, 7)).toEqual(['get_x', 'tools']);
    const { hits } = scanCodeForDocs('// SPEC §Impulse-shapes, path docs/SPEC.md', new Set(['SPEC']));
    expect(hits.map((h: any) => `${h.name} ${h.section}`)).toEqual(['SPEC impulse-shapes']);
  });
  test('resolveAnchor understands TS declarations, and a call is not one', () => {
    const ts = [
      'export const FooTool: Tool = {', '};',
      'export async function pick<T extends object>(a: T): Promise<T> {', '}',
      'export abstract class Base<T> {', '  private generate(node: Node): Float32Array {', '  }', '}',
      'export interface Shape {', '}', 'export type Alias = string;', 'export enum Mode { A }',
      'main().catch((e) => {', '});',
    ].join('\n');
    for (const [name, line] of [['FooTool', 1], ['pick', 3], ['Base', 5], ['generate', 6], ['Shape', 9], ['Alias', 11], ['Mode', 12]] as const) {
      expect(resolveAnchor(ts, name)).toMatchObject({ ok: true, line });
    }
    expect(resolveAnchor(ts, 'main').ok).toBe(false);
  });
  test('symbol regions span TS return types, object return types, generics and multi-line arrows', () => {
    const ts = [
      'export async function handle(', '  input: In,', '): Promise<{ ok: boolean }> {', '  return x;', '}',
      'function map(p: P): {', '  a: string;', '} {', '  return p;', '}',
      'export const run = async (', '  a: number,', '): Promise<void> => {', '  go();', '};',
      'class K {', '  private gen<T>(n: T): T[] {', '    return [n];', '  }', '}',
    ].join('\n');
    const r = Object.fromEntries(symbolRegions(ts).map((x: any) => [x.name, [x.start, x.end]]));
    expect(r).toMatchObject({ handle: [1, 5], map: [6, 10], run: [11, 15], K: [16, 20], gen: [17, 19] });
  });
});

describe('doclinks: impact is precise', () => {
  const files = {
    [CODE]: code, 'docs/SPEC.md': SPEC,
    'docs/live/b.md': 'mentions `src/x.ts`', 'docs/live/c.md': 'covers x',
    'src/y.ts': '// SPEC §get_y\nexport const y = 1;\n',
  };
  const repo = fixture(files);
  const d = baseDb(); d.curated.covers['docs/live/c.md'] = [CODE]; d.derived = build(repo, d);
  const names = (l: any[]) => l.map(i => i.target).sort().join(',');

  test('a body edit names the doc anchoring its function (by section), the covering doc and the cited section', () => {
    const touched = impacted(repo, d, [CODE], { editText: '  return run(input);', editSnippets: ['  return run(input);'] });
    expect(names(touched)).toBe('docs/SPEC.md,docs/live/c.md');
    const spec = touched.find((i: any) => i.target === 'docs/SPEC.md');
    expect(spec.why).toContain('src/x.ts cites SPEC §get_x');
    expect(spec.why).toContain('§get_x cites @handle');
  });
  test('editing a SPEC section names only the code citing that section (or a parent of it)', () => {
    expect(names(impacted(repo, d, ['docs/SPEC.md'], { editText: 'Other text about get_y.' }))).toBe('src/y.ts');
    expect(names(impacted(repo, d, ['docs/SPEC.md'], { editText: 'Handler: `src/x.ts@handle`' }))).toBe('src/x.ts');
  });
});

// The CLI and hook contract runs the script as a child process in a throwaway git repository. It is
// skipped on Windows: the scanner itself runs there through the real-tree tests above, and the
// child-process + temp-repo plumbing (git identity, path translation in hook stdin) is exercised on Linux.
describe.skipIf(process.platform === 'win32')('doclinks: CLI and hooks in a real git fixture', () => {
  const run = (root: string, cmd: string[], input?: unknown) => spawnSync(process.execPath, [join(root, 'scripts/doclinks.mjs'), ...cmd], {
    cwd: root, input: input == null ? '' : JSON.stringify(input), encoding: 'utf8',
  });
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'doclinks-cli-'));
    for (const dir of ['scripts', 'src', 'docs']) mkdirSync(join(root, dir), { recursive: true });
    const files: Files = {
      [CODE]: code,
      // The excerpt in the section that cites src/x.ts is shown; the one in another section is not.
      'docs/SPEC.md': SPEC.replace('Handler: `src/x.ts@handle`\n', 'Handler: `src/x.ts@handle`\n\nThe `handle` function returns the run result.\n')
        + '\nEach module exports a `handle` of its own.\n',
      'src/other.ts': 'export const other = 1;\n',
    };
    for (const [f, t] of Object.entries(files)) writeFileSync(join(root, f), t);
    const d = baseDb(); d.curated.covers['docs/SPEC.md'] = [CODE]; d.derived = build(fixture(files), d);
    writeFileSync(join(root, 'docs/links.json'), JSON.stringify(d, null, 2));
    writeFileSync(join(root, 'scripts/doclinks.mjs'), readFileSync(SCRIPT, 'utf8'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Doclinks Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    writeFileSync(join(root, CODE), code.replace('return run(input)', 'return run(input, 2)'));
    return { root, git };
  };

  test.skipIf(process.platform === 'win32')('hook-post finds the edited file when its path goes through a symlink to the repository', () => {
    // macOS's temp dir /var is a link to /private/var: the hook is handed the linked path, while the script knows
    // its own real one.
    const { root } = setup();
    const link = join(mkdtempSync(join(tmpdir(), 'doclinks-link-')), 'repo');
    symlinkSync(root, link);
    try {
      const post = run(root, ['hook-post'], { tool_input: { file_path: join(link, CODE), old_string: '  return run(input);', new_string: '  return run(input, 2);' } });
      expect(post.status).toBe(0);
      expect(JSON.parse(post.stdout).hookSpecificOutput.additionalContext).toContain('§get_x cites @handle');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });

  test('an untracked doc or code file never enters derived; staging it does', () => {
    const { root, git } = setup();
    try {
      const before = build(gitRepo(root), loadDb(gitRepo(root)));
      writeFileSync(join(root, 'docs/NOTES.md'), '# Notes\n\nSee `src/x.ts@handle` and `src/x.ts@door`.\n');
      writeFileSync(join(root, 'src/scratch.ts'), '// SPEC §get_y\nexport const s = 1;\n');
      const untracked = gitRepo(root);
      expect(untracked.files).not.toContain('docs/NOTES.md');
      expect(build(untracked, loadDb(untracked))).toEqual(before);
      expect(run(root, ['check']).stdout + run(root, ['check']).stderr).not.toContain('stale');
      expect(untracked.changed()).not.toContain('docs/NOTES.md');

      git('add', 'docs/NOTES.md', 'src/scratch.ts');
      const staged = gitRepo(root);
      const after = build(staged, loadDb(staged));
      expect(JSON.stringify(after)).toContain('docs/NOTES.md');
      expect(JSON.stringify(after)).toContain('src/scratch.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('check, impacted, hook-post, hook-stop, precommit, reviewed', () => {
    const { root, git } = setup();
    try {
      expect(run(root, ['check']).status).toBe(0);

      const imp = run(root, ['impacted']);
      expect(imp.status).toBe(0);
      expect(imp.stdout).toContain('src/x.ts cites SPEC §get_x');
      expect(imp.stdout).toContain('mentions handle: The `handle` function returns the run result.');
      expect(imp.stdout).not.toContain('of its own');

      const post = run(root, ['hook-post'], { tool_input: { file_path: join(root, CODE), old_string: '  return run(input);', new_string: '  return run(input, 2);' } });
      expect(post.status).toBe(0);
      const body = JSON.parse(post.stdout);
      expect(body.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(body.hookSpecificOutput.additionalContext).toContain('§get_x cites @handle');

      const quiet = run(root, ['hook-post'], { tool_input: { file_path: join(root, 'src/other.ts'), content: 'export const other = 2;\n' } });
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toBe('');                              // nothing linked: no context, no noise

      const stop = run(root, ['hook-stop'], {});
      expect(stop.status).toBe(0);
      const stopBody = JSON.parse(stop.stdout);
      expect(stopBody.decision).toBe('block');
      expect(stopBody.reason).toContain('docs/SPEC.md');
      expect(run(root, ['hook-stop'], { stop_hook_active: true }).stdout).toBe('');   // reminds once, never loops

      git('add', CODE);
      const pre = run(root, ['precommit']);
      expect(pre.status).toBe(0);                                  // warns, never blocks
      expect(pre.stderr).toContain('docs/SPEC.md');

      const rev = run(root, ['reviewed', 'docs/SPEC.md', '--why', 'handle still returns the run result']);
      expect(rev.status).toBe(0);
      const after = JSON.parse(readFileSync(join(root, 'docs/links.json'), 'utf8'));
      expect(after.curated.reviewed['docs/SPEC.md'].why).toBe('handle still returns the run result');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
