/**
 * Locating the `bun` launcher for the Node-side trampoline in cli.ts.
 *
 * Split out of cli.ts so the Windows-specific resolution has unit tests: the CI
 * matrix runs the suite on windows-latest, which is the only place the real
 * PATHEXT/cmd-shim behavior can be exercised.
 */
import { existsSync } from 'node:fs';
// win32 semantics explicitly, not the runtime-global `join`/`delimiter`: the Windows
// branch must behave the same wherever it is exercised, including the unit tests on
// the Linux CI leg (`;` separator, backslash joins).
import { win32 as pathWin32 } from 'node:path';

export interface BunLauncher {
  /** Command to spawn — a bare name on POSIX, a resolved absolute path on Windows. */
  command: string;
  /** True when the resolved target is a .cmd/.bat shim and must go through a shell. */
  shell: boolean;
}

export interface ResolveEnv {
  platform?: string;
  path?: string;
  pathext?: string;
  exists?: (p: string) => boolean;
}

/**
 * POSIX: a bare `bun` is enough — execvp searches PATH.
 *
 * Windows: it is not. Bun arrives either as a real `bun.exe` (the bun.sh installer,
 * scoop, winget) or as a `bun.cmd` shim (`npm i -g bun`), and Node refuses to spawn
 * .cmd/.bat without a shell (CVE-2024-27980). Resolve the file first, prefer the
 * .exe because it needs no shell, and report when a shim forces one.
 *
 * Returns null when bun is not on PATH at all, which the caller turns into the
 * "install bun" message rather than an opaque spawn failure.
 */
export function resolveBunLauncher(env: ResolveEnv = {}): BunLauncher | null {
  const platform = env.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'bun', shell: false };

  const exists = env.exists ?? existsSync;
  const rawExts = (env.pathext ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // .exe first regardless of PATHEXT order — it is the one that needs no shell.
  const exts = ['.exe', ...rawExts.filter((e) => e !== '.exe')];

  const dirs = (env.path ?? process.env.PATH ?? '')
    .split(pathWin32.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      // PATH entries on Windows are sometimes quoted.
      const candidate = pathWin32.join(dir.replace(/^"|"$/g, ''), `bun${ext}`);
      if (exists(candidate)) {
        return { command: candidate, shell: /\.(cmd|bat)$/i.test(candidate) };
      }
    }
  }
  return null;
}

/**
 * Quote a command line for cmd.exe.
 *
 * `shell: true` on Windows passes the command line through verbatim, and real
 * install paths contain spaces ("C:\\Users\\First Last\\AppData\\..."), so the
 * quoting has to happen here rather than being left to Node.
 */
export function winQuote(parts: string[]): string {
  return parts
    .map((p) => (/[\s&|<>^"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p))
    .join(' ');
}
