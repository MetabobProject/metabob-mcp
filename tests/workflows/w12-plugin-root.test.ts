/**
 * A server started in the plugin's own folder (SPEC §workspace): an Agent Plugins client sets PLUGIN_ROOT and may
 * launch the server there, with no MCP roots. A plugin folder is no project, so every tool but init_workspace with a
 * path answers workspace_undetermined until the agent names the project; the identity is then derived from it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer, cleanupTempDirs, makeWorkspace, tempDir } from './harness/mcp-client';

afterAll(() => cleanupTempDirs());

const line = (text: string, key: string) => (text.split('\n').find((l) => l.trimStart().startsWith(key)) ?? '').trim();
const real = (p: string) => realpathSync.native(p);

function pluginFolder(): string {
  const dir = join(tempDir('plugin-cache'), 'metabob', '0.3.5');
  mkdirSync(join(dir, 'skills', 'metabob'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), '{}\n');
  return dir;
}

describe('a server started in the plugin\'s own folder', () => {
  test('refuses every tool until init_workspace names the project, then works there, as that project', async () => {
    const plugin = pluginFolder();
    // By its real path: a launch in it gives that form (macOS's /var → /private/var), and init_workspace takes a path as given.
    const project = real(makeWorkspace('the-project'));
    const home = tempDir('plugin-home');
    let direct = '';
    const asProject = await McpServer.start({ workspace: project, home, env: { WORKSPACE_PATH: undefined } });
    try {
      direct = line((await asProject.call('get_analysis_context', {})).text, 'as:').replace(/\(session [^)]*\)/, '');
      expect(direct).toMatch(/^as: +metabob-mcp-/);
      expect(direct).toMatch(/^as: +metabob-mcp-/);
    } finally {
      await asProject.stop();
    }

    const server = await McpServer.start({ workspace: plugin, home, env: { PLUGIN_ROOT: plugin, PLUGIN_DATA: tempDir('plugin-data'), WORKSPACE_PATH: undefined } });
    try {
      for (const [tool, args] of [
        ['record_finding', { files: ['src/index.ts'], summary: 'would land on the plugin folder', severity: 'LOW', category: 'test' }],
        ['get_problems', {}],
        ['get_analysis_context', {}],
        ['predict_cochanges', { changed_files: ['src/index.ts'] }],
        ['init_workspace', {}],
      ] as const) {
        const r = await server.call(tool, args as Record<string, unknown>);
        expect({ tool, text: r.text.split(':')[0] }).toEqual({ tool, text: 'workspace_undetermined' });
        expect(r.text).toContain('init_workspace { workspace_path');
      }

      await server.call('init_workspace', { workspace_path: project }, 120_000);
      const ctx = await server.call('get_analysis_context', {});
      expect(line(ctx.text, 'workspace:')).toStartWith(`workspace:  ${project} (from init_workspace)`);
      // The identity is the project's, as a launch in the project gives, never the plugin folder's.
      expect(line(ctx.text, 'as:').replace(/\(session [^)]*\)/, '')).toBe(direct);
      await server.call('record_finding', { files: ['src/index.ts'], summary: 'recorded in the project', severity: 'LOW', category: 'test' });
      expect((await server.call('get_problems', {})).text).toContain('recorded in the project');
    } finally {
      await server.stop();
    }
  });

  test('a path inside the plugin folder, or one that does not exist, binds nothing; the project then binds as itself', async () => {
    const plugin = pluginFolder();
    const project = real(makeWorkspace('after-mistakes'));
    const home = tempDir('mistakes-home');
    let direct = '';
    const asProject = await McpServer.start({ workspace: project, home, env: { WORKSPACE_PATH: undefined } });
    try {
      direct = line((await asProject.call('get_analysis_context', {})).text, 'as:').replace(/\(session [^)]*\)/, '');
      expect(direct).toMatch(/^as: +metabob-mcp-/);
      expect(direct).toMatch(/^as: +metabob-mcp-/);
    } finally {
      await asProject.stop();
    }
    const server = await McpServer.start({ workspace: plugin, home, env: { PLUGIN_ROOT: plugin, WORKSPACE_PATH: undefined } });
    try {
      for (const path of ['.', 'skills', plugin]) {
        const r = await server.call('init_workspace', { workspace_path: path }, 120_000);
        expect({ path, text: r.text }).toEqual({ path, text: expect.stringMatching(/^workspace_undetermined: .* is the plugin's own folder .*nothing was bound\. Pass the project's absolute path/) });
      }
      const missing = await server.call('init_workspace', { workspace_path: join(tempDir('gone'), 'mistyped') }, 120_000);
      expect(missing.text).toMatch(/is not a directory; nothing was bound/);
      // Nothing was bound: every other tool still waits for the project.
      expect((await server.call('record_finding', { files: ['a.ts'], summary: 'nowhere', severity: 'LOW', category: 'test' })).text).toStartWith('workspace_undetermined:');

      await server.call('init_workspace', { workspace_path: project }, 120_000);
      const ctx = await server.call('get_analysis_context', {});
      expect(line(ctx.text, 'workspace:')).toStartWith(`workspace:  ${project} (from init_workspace)`);
      expect(line(ctx.text, 'as:').replace(/\(session [^)]*\)/, '')).toBe(direct);
    } finally {
      await server.stop();
    }
  });

  test('a project with nothing to index still becomes the workspace', async () => {
    const plugin = pluginFolder();
    const project = real(tempDir('docs-only'));
    writeFileSync(join(project, 'README.md'), '# notes\n');
    const server = await McpServer.start({ workspace: plugin, env: { PLUGIN_ROOT: plugin, WORKSPACE_PATH: undefined } });
    try {
      const init = await server.call('init_workspace', { workspace_path: project }, 120_000);
      expect(init.text).toContain('No indexable files');
      const rec = await server.call('record_finding', { files: ['README.md'], summary: 'a docs-only project', severity: 'LOW', category: 'test' });
      expect(rec.text).toContain('Finding recorded');
      expect(line((await server.call('get_analysis_context', {})).text, 'workspace:')).toStartWith(`workspace:  ${project} (from init_workspace)`);
    } finally {
      await server.stop();
    }
  });

  test('PLUGIN_ROOT with a launch elsewhere, or a client with roots, works as before', async () => {
    const plugin = pluginFolder();
    const elsewhere = real(makeWorkspace('launched-elsewhere'));
    const a = await McpServer.start({ workspace: elsewhere, env: { PLUGIN_ROOT: plugin, WORKSPACE_PATH: undefined } });
    try {
      expect(line((await a.call('get_analysis_context', {})).text, 'workspace:')).toStartWith(`workspace:  ${elsewhere} (from launch directory)`);
    } finally {
      await a.stop();
    }
    const rooted = real(makeWorkspace('rooted-project'));
    const b = await McpServer.start({ workspace: plugin, roots: [rooted], env: { PLUGIN_ROOT: plugin, WORKSPACE_PATH: undefined } });
    try {
      expect(line((await b.call('get_analysis_context', {})).text, 'workspace:')).toStartWith(`workspace:  ${rooted} (from client roots)`);
      expect((await b.call('record_finding', { files: ['src/index.ts'], summary: 'in the rooted project', severity: 'LOW', category: 'test' })).text).toContain('Finding recorded');
    } finally {
      await b.stop();
    }
  });
});
