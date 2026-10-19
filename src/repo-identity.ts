/**
 * The repository a workspace belongs to, as the findings ledger keys it
 * (SPEC §repository-identity).
 *
 * A workspace's basename is not an identity: every repository called `app`,
 * `backend` or `ws` in an org would share one ledger. The identity is the
 * normalized URL of the `origin` remote — the same for every clone, wherever it
 * sits on disk — plus the workspace's path below the repository root when the
 * workspace is a subdirectory, so two packages of one monorepo stay apart. With
 * no `origin` (no git, not a repository, no remote) it is the basename.
 *
 * Node-safe: doctor runs under Node, so this uses node:child_process only.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

export interface RepoIdentity {
  /** The ledger key: the normalized origin URL (`github.com/org/repo`), or the basename. Compared case-insensitively. */
  id: string;
  /** The workspace's basename: the legacy ledger key, which recall still matches. */
  name: string;
  source: 'origin' | 'basename';
}

/**
 * Normalize a git remote URL to `host/path`, lowercased, so every spelling of one
 * remote compares equal: scheme, credentials, port, query, a trailing `.git` and
 * trailing slashes are dropped, and the scp form `git@host:org/repo` reads as
 * `host/org/repo`. A local-path remote has no host and keeps its path (resolved
 * against `base` when relative). Returns null for an empty or unparseable URL.
 */
export function normalizeRemoteUrl(url: string, base?: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  let host = '';
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme && scheme[1]!.toLowerCase() !== 'file') {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    host = parsed.hostname;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      path = parsed.pathname;
    }
  } else if (scheme) {
    path = raw.slice(scheme[0].length);
  } else {
    // scp-like `[user@]host:path`. A one-letter "host" is a Windows drive (`C:\…`).
    const scp = /^(?:[^@/\\]+@)?([^:/\\]+):(.+)$/.exec(raw);
    if (scp && scp[1]!.length > 1) {
      host = scp[1]!;
      path = scp[2]!;
    } else {
      path = base && !isAbsolute(raw) ? resolve(base, raw) : raw;
    }
  }
  path = path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    // A drive letter is a machine-local root, like a leading `/`: `d:/home/me/x` and `/home/me/x` name the same path.
    .replace(/^[a-z]:(?=\/)/i, '')
    .replace(/^\/+/, '');
  const id = (host ? `${host}/${path}` : path).toLowerCase();
  return id || null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch {
    // git not installed, not a repository, or no such remote.
    return null;
  }
}

function real(p: string): string {
  try {
    // .native resolves Windows 8.3 short names (RUNNER~1) and drive-letter case the way git reports
    // --show-toplevel, so the workspace's path relative to the repository root is computed between like forms.
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

const cache = new Map<string, RepoIdentity>();

/**
 * The identity of the repository `workspacePath` belongs to. Read once per path
 * and cached for the process: `git remote get-url origin` (which applies
 * `url.<base>.insteadOf`) and `git rev-parse --show-toplevel`.
 */
export function repoIdentity(workspacePath: string): RepoIdentity {
  const key = resolve(workspacePath);
  const hit = cache.get(key);
  if (hit) return hit;

  const name = basename(key);
  let identity: RepoIdentity = { id: name, name, source: 'basename' };
  const top = git(key, ['rev-parse', '--show-toplevel']);
  const url = top ? git(key, ['remote', 'get-url', 'origin']) : null;
  const origin = url && top ? normalizeRemoteUrl(url, top) : null;
  if (origin && top) {
    const sub = relative(real(top), real(key)).replace(/\\/g, '/').toLowerCase();
    const inside = sub && !sub.startsWith('..') && !isAbsolute(sub);
    identity = { id: inside ? `${origin}/${sub}` : origin, name, source: 'origin' };
  }
  cache.set(key, identity);
  return identity;
}

/** Forget cached identities (tests that rewrite a workspace's remote). */
export function clearRepoIdentityCache(): void {
  cache.clear();
}
