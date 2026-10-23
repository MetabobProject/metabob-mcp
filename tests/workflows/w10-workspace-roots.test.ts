/**
 * The workspace (SPEC §workspace): an init_workspace path, then WORKSPACE_PATH, then the client's first root, then
 * the launch directory. A server started outside the project (as an Agent Plugins host starts it) works in the
 * client's root; a change of roots moves the store's scope but never the identity.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer, cleanupTempDirs, makeWorkspace, tempDir } from './harness/mcp-client';

afterAll(() => cleanupTempDirs());

/** A workspace by its real path: the server reports roots and the launch directory resolved (macOS's /var → /private/var). */
const ws = (name: string) => realpathSync.native(makeWorkspace(name));
/** The workspace line, its path by native real path (Windows 8.3 forms and macOS links compare equal). */
function where(text: string): { path: string; rest: string } {
  const m = /^workspace: {2}(.+?) (\(from .*)$/.exec(line(text, 'workspace:'));
  if (!m) return { path: '', rest: line(text, 'workspace:') };
  let path = m[1]!;
  try { path = realpathSync.native(path); } catch { /* as given */ }
  return { path, rest: m[2]! };
}
const line = (text: string, key: string) => (text.split('\n').find((l) => l.trimStart().startsWith(key)) ?? '').trim();

describe('the workspace comes from the client when it is not configured', () => {
  test('a server launched elsewhere works in the client\'s first root; a new root moves the store, not the identity', async () => {
    const launched = ws('plugin-folder');
    const projectB = ws('project-b');
    const projectC = ws('project-c');
    const server = await McpServer.start({ workspace: launched, roots: [projectB], env: { WORKSPACE_PATH: undefined } });
    try {
      const ctx = await server.call('get_analysis_context', {});
      expect(where(ctx.text)).toEqual({ path: realpathSync.native(projectB), rest: '(from client roots)' });
      const identity = line(ctx.text, 'as:');
      expect(identity).toMatch(/^as: +metabob-mcp-/);

      await server.call('record_finding', { files: ['src/index.ts'], summary: 'in project b', severity: 'LOW', category: 'test' });
      expect((await server.call('get_problems', {})).text).toContain('in project b');

      server.setRoots([projectC]);
      // The server re-reads its roots; the next call sees the new workspace.
      for (let i = 0; i < 40 && server.rootsRequests < 2; i++) await Bun.sleep(50);
      const moved = await server.call('get_analysis_context', {});
      expect(where(moved.text)).toEqual({ path: realpathSync.native(projectC), rest: '(from client roots)' });
      expect(line(moved.text, 'as:')).toBe(`${identity}; identity derived from ${projectB}, kept for this session`);
      // The store's scope moved with the root: project b's local finding is not project c's.
      expect((await server.call('get_problems', {})).text).not.toContain('in project b');
    } finally {
      await server.stop();
    }
  });

  test.skipIf(process.platform === 'win32')('a root given through a symlink is the same checkout as a launch in it: same identity, same store', async () => {
    const real = realpathSync(makeWorkspace('linked-target'));
    const link = join(mkdtempSync(join(tmpdir(), 'mcp-wf-link-')), 'via-link');
    symlinkSync(real, link);
    const home = tempDir('shared-home');
    const direct = await McpServer.start({ workspace: real, home, env: { WORKSPACE_PATH: undefined } });
    let identity = '';
    try {
      identity = line((await direct.call('get_analysis_context', {})).text, 'as:');
      await direct.call('record_finding', { files: ['src/index.ts'], summary: 'recorded in the real directory', severity: 'LOW', category: 'test' });
    } finally {
      await direct.stop();
    }
    const viaRoot = await McpServer.start({ workspace: makeWorkspace('elsewhere-2'), home, roots: [link], env: { WORKSPACE_PATH: undefined } });
    try {
      const ctx = await viaRoot.call('get_analysis_context', {});
      expect(where(ctx.text)).toEqual({ path: realpathSync.native(real), rest: '(from client roots)' });
      // The server reports the resolved path, never the symlink as given.
      expect(line(ctx.text, 'workspace:')).not.toContain(link);
      expect(line(ctx.text, 'as:').replace(/\(session [^)]*\)/, '')).toBe(identity.replace(/\(session [^)]*\)/, ''));
      expect((await viaRoot.call('get_problems', {})).text).toContain('recorded in the real directory');
    } finally {
      await viaRoot.stop();
    }
  });

  test('WORKSPACE_PATH wins over the client\'s roots', async () => {
    const configured = ws('configured');
    const server = await McpServer.start({ workspace: makeWorkspace('elsewhere'), roots: [makeWorkspace('rooted')], env: { WORKSPACE_PATH: configured } });
    try {
      { const w = where((await server.call('get_analysis_context', {})).text); expect(w.path).toBe(realpathSync.native(configured)); expect(w.rest).toMatch(/^\(from WORKSPACE_PATH\); other roots: .*rooted$/); }
    } finally {
      await server.stop();
    }
  });

  test('a client without roots works in the launch directory, with no wait', async () => {
    const launched = ws('no-roots');
    const server = await McpServer.start({ workspace: launched, env: { WORKSPACE_PATH: undefined } });
    try {
      const started = Date.now();
      const ctx = await server.call('get_analysis_context', {});
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(where(ctx.text)).toEqual({ path: realpathSync.native(launched), rest: '(from launch directory)' });
      expect(server.rootsRequests).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test('an init_workspace path wins over the roots for the rest of the session', async () => {
    const chosen = ws('chosen');
    const server = await McpServer.start({ workspace: makeWorkspace('launch'), roots: [makeWorkspace('root')], env: { WORKSPACE_PATH: undefined } });
    try {
      await server.call('init_workspace', { workspace_path: chosen }, 120_000);
      { const w = where((await server.call('get_analysis_context', {})).text); expect(w.path).toBe(realpathSync.native(chosen)); expect(w.rest).toMatch(/^\(from init_workspace\); other roots: .*root$/); }
    } finally {
      await server.stop();
    }
  });
});
