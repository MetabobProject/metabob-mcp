/**
 * The server on Node alone (SPEC §runtime): the built CLI under a Node with node:sqlite runs the server in-process,
 * its local store on node:sqlite, with no Bun involved. Runs on the built dist (MCP_UNDER_TEST=dist) where a `node`
 * with node:sqlite is on PATH; elsewhere it is skipped, and the no-Bun package smoke covers it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

afterAll(() => cleanupTempDirs());

const nodeHasSqlite = spawnSync('node', ['-e', "require('node:sqlite')"], { stdio: 'ignore' }).status === 0;
const runs = process.env.MCP_UNDER_TEST === 'dist' && nodeHasSqlite;

describe('the server under Node', () => {
  test.skipIf(!runs)('runs in-process on node:sqlite: a finding is stored and recalled, and no SQLite warning reaches stderr', async () => {
    const server = await McpServer.start({
      runtime: 'node',
      workspace: makeWorkspace('node-runtime'),
      initTimeoutMs: 60_000,
      // Unattached: nothing leaves the machine; the local store is what is under test.
      env: { METABOB_API_KEY: undefined },
    });
    try {
      const recorded = await server.call('record_finding', { files: ['src/index.ts'], summary: 'stored under node', severity: 'LOW', category: 'test' });
      expect(recorded.text).toContain('Finding recorded');
      const problems = await server.call('get_problems', {});
      expect(problems.text).toContain('stored under node');
      expect(server.stderr).toMatch(/"runtime":"node \d+\./);
      expect(server.stderr).not.toMatch(/ExperimentalWarning|SQLite is an experimental/i);
      expect(server.strayStdout).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});
