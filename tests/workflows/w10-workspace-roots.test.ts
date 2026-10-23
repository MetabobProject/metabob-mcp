/**
 * The workspace (SPEC §workspace): an init_workspace path, then WORKSPACE_PATH, then the client's first root, then
 * the launch directory. A server started outside the project (as an Agent Plugins host starts it) works in the
 * client's root; a change of roots moves the store's scope but never the identity.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

afterAll(() => cleanupTempDirs());

const line = (text: string, key: string) => (text.split('\n').find((l) => l.trimStart().startsWith(key)) ?? '').trim();

describe('the workspace comes from the client when it is not configured', () => {
  test('a server launched elsewhere works in the client\'s first root; a new root moves the store, not the identity', async () => {
    const launched = makeWorkspace('plugin-folder');
    const projectB = makeWorkspace('project-b');
    const projectC = makeWorkspace('project-c');
    const server = await McpServer.start({ workspace: launched, roots: [projectB], env: { WORKSPACE_PATH: undefined } });
    try {
      const ctx = await server.call('get_analysis_context', {});
      expect(line(ctx.text, 'workspace:')).toBe(`workspace:  ${projectB} (from client roots)`);
      const identity = line(ctx.text, 'as:');
      expect(identity).toMatch(/^as: +metabob-mcp-/);

      await server.call('record_finding', { files: ['src/index.ts'], summary: 'in project b', severity: 'LOW', category: 'test' });
      expect((await server.call('get_problems', {})).text).toContain('in project b');

      server.setRoots([projectC]);
      // The server re-reads its roots; the next call sees the new workspace.
      for (let i = 0; i < 40 && server.rootsRequests < 2; i++) await Bun.sleep(50);
      const moved = await server.call('get_analysis_context', {});
      expect(line(moved.text, 'workspace:')).toBe(`workspace:  ${projectC} (from client roots)`);
      expect(line(moved.text, 'as:')).toBe(`${identity}; identity derived from ${projectB}, kept for this session`);
      // The store's scope moved with the root: project b's local finding is not project c's.
      expect((await server.call('get_problems', {})).text).not.toContain('in project b');
    } finally {
      await server.stop();
    }
  });

  test('WORKSPACE_PATH wins over the client\'s roots', async () => {
    const configured = makeWorkspace('configured');
    const server = await McpServer.start({ workspace: makeWorkspace('elsewhere'), roots: [makeWorkspace('rooted')], env: { WORKSPACE_PATH: configured } });
    try {
      expect(line((await server.call('get_analysis_context', {})).text, 'workspace:')).toMatch(new RegExp(`^workspace:  ${configured} \\(from WORKSPACE_PATH\\); other roots: .*rooted$`));
    } finally {
      await server.stop();
    }
  });

  test('a client without roots works in the launch directory, with no wait', async () => {
    const launched = makeWorkspace('no-roots');
    const server = await McpServer.start({ workspace: launched, env: { WORKSPACE_PATH: undefined } });
    try {
      const started = Date.now();
      const ctx = await server.call('get_analysis_context', {});
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(line(ctx.text, 'workspace:')).toBe(`workspace:  ${launched} (from launch directory)`);
      expect(server.rootsRequests).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test('an init_workspace path wins over the roots for the rest of the session', async () => {
    const chosen = makeWorkspace('chosen');
    const server = await McpServer.start({ workspace: makeWorkspace('launch'), roots: [makeWorkspace('root')], env: { WORKSPACE_PATH: undefined } });
    try {
      await server.call('init_workspace', { workspace_path: chosen }, 120_000);
      expect(line((await server.call('get_analysis_context', {})).text, 'workspace:')).toMatch(new RegExp(`^workspace:  ${chosen} \\(from init_workspace\\); other roots: .*root$`));
    } finally {
      await server.stop();
    }
  });
});
