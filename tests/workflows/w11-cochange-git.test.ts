/**
 * Co-change from git history (SPEC §predict_cochanges): predict_cochanges answers from the checkout's history with
 * no init_workspace, while analyze_impact, which walks the code index, still asks for one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

afterAll(() => cleanupTempDirs());

function withHistory(name: string): string {
  const ws = makeWorkspace(name, { 'src/schema.json': '{}\n' });
  const git = (...args: string[]) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '.'); git('commit', '-qm', 'one');
  writeFileSync(join(ws, 'src/index.ts'), 'export const answer = 43;\n');
  writeFileSync(join(ws, 'src/schema.json'), '{"a":1}\n');
  git('add', '.'); git('commit', '-qm', 'two');
  return ws;
}

describe('co-change from git history', () => {
  test('predict_cochanges needs no init_workspace; analyze_impact still does', async () => {
    const server = await McpServer.start({ workspace: withHistory('cochange'), env: { METABOB_API_KEY: undefined } });
    try {
      const pred = await server.call('predict_cochanges', { changed_files: ['src/index.ts'] });
      expect(pred.text).toContain('From git history');
      expect(pred.text).toMatch(/1\. src\/schema\.json\n   Confidence: 100% \(co-changed in 2 commits\)/);
      expect(pred.text).not.toContain('init_workspace');

      const impact = await server.call('analyze_impact', { changed_files: ['src/index.ts'] });
      expect(impact.text).toContain('init_workspace');
    } finally {
      await server.stop();
    }
  });
});
