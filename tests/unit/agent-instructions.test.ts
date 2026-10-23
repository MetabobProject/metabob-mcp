/**
 * One instruction file for every agent harness (README §agent-instructions): AGENTS.md at the root, read natively
 * by Codex, Copilot, Kiro, Cursor, Junie and others; GEMINI.md and a Continue rule point at it; and no stale
 * per-harness file that a first-match reader (Zed) would read instead of it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('agent instruction files', () => {
  test('AGENTS.md carries the ledger rules and the development flow', () => {
    const text = read('AGENTS.md');
    for (const term of ['get_problems', 'path_activity', 'record_finding', 'mark_complete', 'claim_finding', 'concept_create', 'repo_anchor', 'attach --check', 'bun run test', 'doclinks', '`dev`']) {
      expect(text).toContain(term);
    }
  });

  test('the pointers point at AGENTS.md', () => {
    expect(read('GEMINI.md')).toMatch(/^@AGENTS\.md$/m);
    const continueRule = read('.continue/rules/metabob.md');
    expect(continueRule).toMatch(/^alwaysApply: true$/m);
    expect(continueRule).toContain('AGENTS.md');
  });

  test('no stale per-harness file shadows AGENTS.md, and none carries the retired workflow', () => {
    for (const f of ['.github/copilot-instructions.md', '.cursorrules', '.windsurfrules', '.clinerules', '.rules']) expect(existsSync(join(ROOT, f))).toBe(false);
    for (const f of ['AGENTS.md', 'GEMINI.md', '.continue/rules/metabob.md']) {
      const text = read(f);
      expect(text).not.toMatch(/annotate_component|mode="recommend"|analysis is asynchronous|`pending` and `running`/i);
    }
  });
});
