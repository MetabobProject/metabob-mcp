/**
 * The default tool set over MCP (SPEC §tool-sets): a server started with METABOB_TOOLS unset lists the shared
 * ledger and memory tools only, tells the agent to load the `metabob` skill, refuses any other tool by naming the
 * one setting that lists every tool, and records and recalls on the ledger as usual.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { DEFAULT_TOOL_SET } from '../../src/tools/index';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

afterAll(() => cleanupTempDirs());

describe('the default tool set', () => {
  test('lists the eleven tools, points at the metabob skill, and refuses the rest with the way to list them', async () => {
    const server = await McpServer.start({ workspace: makeWorkspace('default-tools'), env: { METABOB_TOOLS: undefined, METABOB_API_KEY: undefined } });
    try {
      const names = (await server.listTools()).map((t) => t.name).sort();
      expect(names).toEqual([...DEFAULT_TOOL_SET].sort());
      const instructions: string = server.initializeResult?.instructions ?? '';
      expect(instructions).toContain('load the `metabob` skill');
      expect(instructions.toLowerCase()).not.toContain('substrate');

      const refused = await server.call('analyze_impact', { changed_files: ['src/index.ts'] });
      // A refusal by name is a protocol error (MethodNotFound), as for any tool the server does not list.
      expect(refused.error?.message).toContain('is not in this server\'s default tool set');
      expect(refused.error?.message).toContain('METABOB_TOOLS=all');

      expect((await server.call('record_finding', { files: ['src/index.ts'], summary: 'kept for the next agent', severity: 'LOW', category: 'test' })).text).toContain('Finding recorded');
      const problems = (await server.call('get_problems', {})).text;
      expect(problems).toContain('kept for the next agent');
      // Nothing points the agent at a tool it cannot call.
      expect(problems).not.toContain('path_activity');
      expect((await server.call('get_problems', { file_path: 'nothing-here.ts' })).text).not.toContain('path_activity');
    } finally {
      await server.stop();
    }
  });
});
