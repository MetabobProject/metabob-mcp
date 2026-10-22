import { expect, test, setDefaultTimeout } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineGitCochanges } from '../../src/git-cochange.js';

// Spawns git or opens an on-disk store per test: well under a second normally, several on a stalled Windows runner.
setDefaultTimeout(30_000);

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cochange-'));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' });
  run('git init -q');
  run('git config user.email t@t && git config user.name t');
  mkdirSync(join(dir, 'src'), { recursive: true });

  const write = (name: string, rev: number) =>
    writeFileSync(join(dir, 'src', name), `// rev ${rev}\n`);

  write('a.ts', 0); write('b.ts', 0); write('c.ts', 0);
  run('git add -A && git commit -qm initial');
  write('lone.ts', 0);
  run('git add -A && git commit -qm "add lone"');

  // a+b co-change 3 times, c joins once, lone changes alone
  for (let i = 1; i <= 3; i++) {
    write('a.ts', i); write('b.ts', i);
    if (i === 2) write('c.ts', i);
    run(`git add -A && git commit -qm "pair rev ${i}"`);
  }
  write('lone.ts', 9);
  run('git add -A && git commit -qm lone');
  return dir;
}

test('mineGitCochanges ranks historical co-change partners by confidence', async () => {
  const repo = makeRepo();
  const predictions = await mineGitCochanges(repo, ['src/a.ts'], 10);

  const byFile = Object.fromEntries(predictions.map(p => [p.filePath, p]));
  expect(byFile['src/b.ts']).toBeDefined();
  expect(byFile['src/b.ts']!.confidence).toBeGreaterThan(byFile['src/c.ts']!.confidence);
  expect(predictions[0]!.filePath).toBe('src/b.ts');
  expect(byFile['src/lone.ts']).toBeUndefined();
});

test('mineGitCochanges returns [] outside a git repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nogit-'));
  expect(await mineGitCochanges(dir, ['x.ts'], 5)).toEqual([]);
});
