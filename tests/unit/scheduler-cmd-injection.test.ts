/**
 * Regression: readRecentCommits must not hand a workspace filename to a shell.
 *
 * The old body was execSync(`git log --oneline -3 -- "${rel}"`). `$(...)`
 * expands inside double quotes, so committing a file named `a$(touch PWNED).ts`
 * executed arbitrary commands the moment the watcher enqueued it. The injection
 * case below is the discriminator: it creates PWNED on the old code and does
 * not on the argv form. (It only discriminates on POSIX — cmd.exe does not
 * expand `$(...)` — but it is left unconditional because it is harmless there.)
 *
 * The second case is the anti-cheat: without it, returning [] unconditionally
 * would "fix" the injection.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecentCommits } from '../../src/scheduler.js';

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sched-inject-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAYLOAD = 'a$(touch PWNED).ts';

test('a shell-metacharacter filename does not execute commands', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, PAYLOAD), '// hi\n');
  // `git add -A` so the test harness itself never interpolates the payload.
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'add payload'], { cwd: repo, stdio: 'ignore' });

  readRecentCommits(join(repo, PAYLOAD), repo);

  // execSync ran with cwd: workspaceRoot, so the payload lands inside the repo.
  expect(existsSync(join(repo, 'PWNED'))).toBe(false);
});

test('the payload filename still yields its real commit history', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, PAYLOAD), '// hi\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'payload subject'], { cwd: repo, stdio: 'ignore' });

  const commits = readRecentCommits(join(repo, PAYLOAD), repo);

  // The shell form rewrote the path to `a.ts` before git saw it, so this
  // returned [] — the argv form is not merely safe, it is more correct.
  expect(commits.length).toBe(1);
  expect(commits[0]!.message).toBe('payload subject');
});

test('an ordinary file returns its hash and commit subject', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'normal.ts'), '// x\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'feat: a known subject'], { cwd: repo, stdio: 'ignore' });

  const commits = readRecentCommits(join(repo, 'normal.ts'), repo);

  expect(commits.length).toBe(1);
  expect(commits[0]!.hash).toMatch(/^[0-9a-f]{7,}$/);
  expect(commits[0]!.message).toBe('feat: a known subject');
  expect(commits[0]!.files_changed).toEqual([]);
});

test('a non-git workspace returns [] rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-nogit-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'x.ts'), '// x\n');

  // buildBundle has no catch of its own here; a throw would drop the queue item.
  expect(readRecentCommits(join(dir, 'x.ts'), dir)).toEqual([]);
});
