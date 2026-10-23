/**
 * The workspace's precedence and the client's roots (SPEC §workspace): WORKSPACE_PATH, then the first file: root,
 * then the launch directory; roots of other schemes are not workspaces; the identity's workspace is kept once set.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuredWorkspace, fileRoots, identityWorkspacePath, resetClientRootsForTests, rootsSettled, setClientRoots, setIdentityWorkspace, workspaceSource } from '../../src/workspace-root';

afterEach(() => resetClientRootsForTests());

describe('the workspace', () => {
  test('only file: roots count, in the client\'s order', () => {
    expect(fileRoots([{ uri: 'https://example.invalid/x' }, { uri: pathToFileURL('/tmp/a').href }, {}, { uri: pathToFileURL('/tmp/b').href }])).toEqual(['/tmp/a', '/tmp/b']);
  });

  test.skipIf(process.platform === 'win32')('a root given through a symlink is the checkout\'s real path, as a launch there gives', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'roots-link-')));
    const real = join(base, 'repo');
    mkdirSync(real);
    symlinkSync(real, join(base, 'linked'));
    expect(fileRoots([{ uri: pathToFileURL(join(base, 'linked')).href }])).toEqual([real]);
    expect(fileRoots([{ uri: pathToFileURL(join(base, 'missing')).href }])).toEqual([join(base, 'missing')]);
  });

  test('WORKSPACE_PATH, then the first root, then the launch directory', () => {
    expect(configuredWorkspace({})).toBe(process.cwd());
    expect(workspaceSource({})).toBe('launch directory');
    setClientRoots(['/tmp/root-a', '/tmp/root-b']);
    expect(configuredWorkspace({})).toBe('/tmp/root-a');
    expect(workspaceSource({})).toBe('client roots');
    expect(configuredWorkspace({ WORKSPACE_PATH: '/tmp/configured' })).toBe('/tmp/configured');
    expect(workspaceSource({ WORKSPACE_PATH: '/tmp/configured' })).toBe('WORKSPACE_PATH');
  });

  test('the wait ends at the first roots answer, or at the bound', async () => {
    const t0 = Date.now();
    await rootsSettled(100);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    setClientRoots([]);
    const t1 = Date.now();
    await rootsSettled(5_000);
    expect(Date.now() - t1).toBeLessThan(100);
  });

  test('the identity\'s workspace is the first one set', () => {
    setIdentityWorkspace('/tmp/first');
    setIdentityWorkspace('/tmp/second');
    expect(identityWorkspacePath()).toBe('/tmp/first');
  });
});
