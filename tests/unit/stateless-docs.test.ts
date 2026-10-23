/**
 * Docs and code state the codebase's purpose and its rules, with the reason for each, never the history of how a
 * rule was reached (CLAUDE §docs-code-links: docs are present and timeless). No tracked doc, source file, script,
 * skill or test names a ruling, a dated decision, a decision or request id, an experiment's tally, or a working
 * session; that evidence belongs in commit messages. "operator ruling" is a product concept (a gap held by an
 * operator's ruling) and is allowed.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const THIS = 'tests/unit/stateless-docs.test.ts';

/** Patterns that record history rather than state a rule. */
const STATEFUL: Array<[string, RegExp]> = [
  ['a user ruling', /\buser rulings?\b/i],
  ['a dated ruling', /\bruled \d{4}-/i],
  ['a decision id', /\b[DL]\d\b/],
  ['a request id', /\bS-\d+\b/],
  ['a lab observation', /\bseen on the lab\b/i],
  ['a measurement record', /\bmeasured\b(?:\s+\w+)?\s+(on|in)\s+\S/i],
  ['an experiment tally', /\b\d+ of \d+ runs\b/i],
  ['a session name', /\bqa\b|\bdev-mcp\b|\bnetwork fork\b/i],
];

function tracked(): string[] {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files', '--', '*.md', 'src', 'scripts', 'skills', 'tests', 'lab'], { encoding: 'utf8' });
  return out.split('\n').filter(f => f && f !== THIS && /\.(md|ts|mjs|js|sh)$/.test(f) && !f.startsWith('vendor/'));
}

describe('docs and code state rules, not their history', () => {
  test.skipIf(process.platform === 'win32')('no tracked file names a ruling, a dated decision, an id, a tally or a session', () => {
    const hits: string[] = [];
    for (const f of tracked()) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/operator ruling/i.test(line)) return;
        for (const [kind, re] of STATEFUL) if (re.test(line)) hits.push(`${f}:${i + 1} ${kind}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
