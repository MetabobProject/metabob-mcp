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
import { existsSync, realpathSync } from 'node:fs';
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

// @anchor fix-location
/**
 * Where a fix to a finding lives in the checkout at `workspacePath`, as mark_complete records it on an endorse
 * (SPEC §mark_complete). A fix commit postdates the finding (`recordedAt`, less FIX_SKEW_MS for clocks), since a
 * commit older than the finding cannot be its fix; a fix may touch files other than the finding's.
 *
 * - `unknown`: not a git checkout, or none of `files` is known to git here (not tracked and not on disk).
 * - `uncommitted`: one of the finding's files has changes git has not committed (modified, staged, untracked or
 *   deleted), or, with no commit since the finding touching them, other tracked files do (`outside`: the fix may be
 *   among them).
 * - `commit`: the newest commit since the finding touching its files, else the newest commit since it at all
 *   (`elsewhere`), with its branch and whether a remote branch holds it.
 * - `none`: a clean checkout with no commit since the finding was recorded: nothing here can be its fix.
 */
export type FixLocation =
  | { kind: 'commit'; sha: string; branch?: string; pushed: boolean; elsewhere?: boolean }
  | { kind: 'uncommitted'; branch?: string; base?: string; outside?: boolean }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** Allowance for the recording machine's clock running ahead of the committing machine's. */
export const FIX_SKEW_MS = 2 * 60_000;

export function fixLocation(workspacePath: string, files: string[], recordedAt?: Date): FixLocation {
  const cwd = resolve(workspacePath);
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return { kind: 'unknown' };
  const paths = files.map(f => f.trim()).filter(Boolean)
    .filter(f => existsSync(resolve(cwd, f)) || !!git(cwd, ['ls-files', '--', f]));
  if (!paths.length) return { kind: 'unknown' };
  const ref = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = ref && ref !== 'HEAD' ? ref : undefined;
  const base = git(cwd, ['rev-parse', 'HEAD']) || undefined;
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', ...paths]);
  if (status === null) return { kind: 'unknown' };
  if (status) return { kind: 'uncommitted', branch, base };
  const since = recordedAt && Number.isFinite(recordedAt.getTime())
    ? [`--since=${new Date(recordedAt.getTime() - FIX_SKEW_MS).toISOString()}`] : [];
  const commit = (sha: string, elsewhere?: boolean): FixLocation =>
    ({ kind: 'commit', sha, branch, pushed: !!git(cwd, ['branch', '-r', '--contains', sha]), ...(elsewhere ? { elsewhere } : {}) });
  const touching = git(cwd, ['log', '-1', '--format=%H', ...since, '--', ...paths]);
  if (touching) return commit(touching);
  if (git(cwd, ['status', '--porcelain', '--untracked-files=no'])) return { kind: 'uncommitted', branch, base, outside: true };
  // With no recorded time, any commit could predate the finding: only one touching its files counts.
  const any = since.length ? git(cwd, ['log', '-1', '--format=%H', ...since]) : null;
  return any ? commit(any, true) : { kind: 'none' };
}

/** Whether commit `sha` is in the history of the checkout's HEAD; null when the workspace is not a git checkout. */
export function commitInHead(workspacePath: string, sha: string): boolean | null {
  const cwd = resolve(workspacePath);
  if (git(cwd, ['rev-parse', '--show-toplevel']) === null) return null;
  // --is-ancestor answers through its exit code: 0 yes, 1 no, 128 when the commit is not in this clone at all.
  return git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']) !== null;
}
