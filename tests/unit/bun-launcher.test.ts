import { describe, expect, it } from 'bun:test';
import { resolveBunLauncher, winQuote } from '../../src/bun-launcher';

// The Node-side trampoline in cli.ts re-execs into bun. On POSIX that is a bare
// `bun`; on Windows it has to be resolved, because bun is either a real bun.exe or
// an npm-generated bun.cmd shim, and Node refuses to spawn .cmd/.bat without a
// shell. These run on the windows-latest CI leg too, which is the only place the
// real path separators and PATHEXT are in play.

const winEnv = (files: string[], overrides: Record<string, unknown> = {}) => ({
  platform: 'win32',
  path: 'C:\\Windows\\system32;C:\\Users\\First Last\\.bun\\bin;C:\\Users\\First Last\\AppData\\Roaming\\npm',
  pathext: '.COM;.EXE;.BAT;.CMD',
  exists: (p: string) => files.includes(p.replace(/\//g, '\\')),
  ...overrides,
});

describe('resolveBunLauncher', () => {
  it('returns a bare `bun` on POSIX — execvp searches PATH', () => {
    expect(resolveBunLauncher({ platform: 'linux' })).toEqual({ command: 'bun', shell: false });
    expect(resolveBunLauncher({ platform: 'darwin' })).toEqual({ command: 'bun', shell: false });
  });

  it('finds bun.exe on Windows and does not need a shell', () => {
    const exe = 'C:\\Users\\First Last\\.bun\\bin\\bun.exe';
    expect(resolveBunLauncher(winEnv([exe]))).toEqual({ command: exe, shell: false });
  });

  it('falls back to a bun.cmd shim (npm i -g bun) and flags that it needs a shell', () => {
    const cmd = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\bun.cmd';
    expect(resolveBunLauncher(winEnv([cmd]))).toEqual({ command: cmd, shell: true });
  });

  it('prefers bun.exe over a bun.cmd shim even when PATHEXT lists .BAT/.CMD first', () => {
    const exe = 'C:\\Users\\First Last\\.bun\\bin\\bun.exe';
    const cmd = 'C:\\Users\\First Last\\.bun\\bin\\bun.cmd';
    const resolved = resolveBunLauncher(winEnv([exe, cmd], { pathext: '.BAT;.CMD;.EXE' }));
    expect(resolved).toEqual({ command: exe, shell: false });
  });

  it('honors PATH order across directories', () => {
    const first = 'C:\\Windows\\system32\\bun.exe';
    const second = 'C:\\Users\\First Last\\.bun\\bin\\bun.exe';
    expect(resolveBunLauncher(winEnv([first, second]))?.command).toBe(first);
  });

  it('tolerates quoted PATH entries', () => {
    const exe = 'C:\\Users\\First Last\\.bun\\bin\\bun.exe';
    const resolved = resolveBunLauncher(
      winEnv([exe], { path: '"C:\\Users\\First Last\\.bun\\bin"' }),
    );
    expect(resolved).toEqual({ command: exe, shell: false });
  });

  it('returns null when bun is nowhere on PATH, so the caller can print guidance', () => {
    expect(resolveBunLauncher(winEnv([]))).toBeNull();
    expect(resolveBunLauncher(winEnv([], { path: '' }))).toBeNull();
  });

  it('does not mistake a different executable for bun', () => {
    expect(resolveBunLauncher(winEnv(['C:\\Windows\\system32\\bunny.exe']))).toBeNull();
  });
});

describe('winQuote', () => {
  it('quotes paths containing spaces — the common Windows install location', () => {
    expect(
      winQuote(['C:\\Users\\First Last\\AppData\\Roaming\\npm\\bun.cmd', '--use-system-ca']),
    ).toBe('"C:\\Users\\First Last\\AppData\\Roaming\\npm\\bun.cmd" --use-system-ca');
  });

  it('leaves ordinary arguments unquoted', () => {
    expect(winQuote(['bun.exe', '--version'])).toBe('bun.exe --version');
  });

  it('quotes cmd.exe metacharacters so they are not interpreted', () => {
    for (const arg of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b']) {
      expect(winQuote(['bun.exe', arg])).toBe(`bun.exe "${arg}"`);
    }
  });

  it('escapes embedded double quotes', () => {
    expect(winQuote(['bun.exe', 'say "hi"'])).toBe('bun.exe "say \\"hi\\""');
  });
});
