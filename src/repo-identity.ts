/**
 * The repository a workspace belongs to, as the findings ledger keys it
 * (SPEC §repository-identity).
 *
 * A workspace's basename is not an identity: every repository called `app`,
 * `backend` or `ws` in an org would share one ledger. The identity is the
 * normalized URL of the `origin` remote — the same for every clone, wherever it
 * sits on disk — plus the workspace's path below the repository root when the
 * workspace is a subdirectory, so two packages of one monorepo stay apart. With
 * no `origin` it is the repository's first commit (`root:<sha>`), which every
 * copy of one history shares and an unrelated repository of the same name does
 * not; with no commit (no git, not a repository, nothing committed yet) it is
 * this directory alone (`local:<hash of its path>`).
 *
 * Node-safe: doctor runs under Node, so this uses node:child_process only.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface RepoIdentity {
  /**
   * The ledger key: the normalized origin URL (`github.com/org/repo`), else `root:<first commit>`, else
   * `local:<hash of the directory's path>`; a workspace below the repository root appends its subpath. Compared
   * case-insensitively.
   */
  id: string;
  /** The workspace's basename: the name shown, and the legacy ledger key, which recall still matches. */
  name: string;
  source: 'origin' | 'root' | 'local';
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

/**
 * The identity read runs at startup and must not stall it (3 s). Where a fix lives is read when an agent endorses,
 * on a checkout that may be busy or a slow runner, so those reads wait longer (FIX_GIT_TIMEOUT_MS): a git call that
 * times out reads as "not known", and must never decide that a fix predates its finding.
 */
const FIX_GIT_TIMEOUT_MS = 20_000;

/**
 * git's environment: no credential prompt, and its messages in English whatever the user's locale, since a
 * failure is told apart by its message ("not a git repository"; a localized git says "kein Git-Repository").
 */
export const GIT_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C' });

function git(cwd: string, args: string[], timeoutMs = 3_000): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      env: GIT_ENV(),
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
  const top = git(key, ['rev-parse', '--show-toplevel']);
  const sub = top ? relative(real(top), real(key)).replace(/\\/g, '/').toLowerCase() : '';
  const below = (base: string) => (sub && !sub.startsWith('..') && !isAbsolute(sub) ? `${base}/${sub}` : base);
  const url = top ? git(key, ['remote', 'get-url', 'origin']) : null;
  const origin = url && top ? normalizeRemoteUrl(url, top) : null;
  if (origin) return remember(key, { id: below(origin), name, source: 'origin' });
  if (top && git(key, ['rev-parse', '--verify', '-q', 'HEAD'])) {
    const root = firstCommit(key);
    // A history git could not walk in time is not "no commit": answer this once, uncached, and read it again next time.
    if (!root) return { id: localId(key), name, source: 'local' };
    return remember(key, { id: below(`root:${root}`), name, source: 'root' });
  }
  return remember(key, { id: localId(key), name, source: 'local' });
}

function remember(key: string, identity: RepoIdentity): RepoIdentity {
  cache.set(key, identity);
  return identity;
}

/** A directory with no commit to name it: its own path, so nothing it records is shared with another directory. */
function localId(key: string): string {
  return `local:${createHash('sha256').update(real(key)).digest('hex').slice(0, 16)}`;
}

/**
 * The first commit of HEAD's history. With several roots (unrelated histories merged), the oldest by commit time,
 * then the lowest sha, so every copy of the history picks the same one. The walk covers the whole history, so it
 * gets the fix-location budget rather than the 3 s of a plain read.
 */
function firstCommit(cwd: string): string | null {
  const roots = (git(cwd, ['rev-list', '--max-parents=0', 'HEAD'], FIX_GIT_TIMEOUT_MS) ?? '').split('\n').filter(Boolean);
  if (roots.length <= 1) return roots[0]?.toLowerCase() ?? null;
  const dated = (git(cwd, ['log', '--no-walk', '--format=%ct %H', ...roots]) ?? '')
    .split('\n').map(l => l.trim().split(' ')).filter(p => p.length === 2).map(([t, h]) => ({ t: Number(t), h: h!.toLowerCase() }));
  if (dated.length !== roots.length) return null;
  dated.sort((a, b) => a.t - b.t || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return dated[0]!.h;
}

/** Forget cached identities (tests that rewrite a workspace's remote). */
export function clearRepoIdentityCache(): void {
  cache.clear();
  aliasCache.clear();
}

/** git, with the fix-location timeout. */
let fixGitTimeoutMs = FIX_GIT_TIMEOUT_MS;
/** How the fix-location reads run git: `git` itself, or (tests only) a wrapper with arguments before git's own. */
let fixGit: { file: string; prefix: string[] } = { file: 'git', prefix: [] };

const fgit = (cwd: string, args: string[]): string | null => {
  const r = fgitTry(cwd, args);
  return 'out' in r ? r.out : null;
};

/**
 * Tests only: the fix-location reads' timeout, and optionally the command that stands in for git (a wrapper that
 * answers late, so a timeout is certain on any machine). null restores git and its timeout.
 */
export function setFixGitTimeoutForTests(ms: number | null, command?: { file: string; prefix: string[] }): void {
  fixGitTimeoutMs = ms ?? FIX_GIT_TIMEOUT_MS;
  fixGit = ms === null || !command ? { file: 'git', prefix: [] } : command;
}

/**
 * Why a fix-location git call gave no answer: `not_repo` (git answered that this is not a repository), `missing`
 * (git is not installed), `timeout` (git did not answer in time), `error` (any other failure). Only the first two
 * mean "not a git checkout"; a timeout or an error must never close a finding.
 */
type GitFailure = 'not_repo' | 'missing' | 'timeout' | 'error';

function fgitTry(cwd: string, args: string[]): { out: string } | { failure: GitFailure } {
  try {
    return {
      out: execFileSync(fixGit.file, [...fixGit.prefix, '-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: fixGitTimeoutMs,
        env: GIT_ENV(),
      }).trim(),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { signal?: string; stderr?: Buffer | string };
    if (e.code === 'ENOENT') return { failure: 'missing' };
    if (e.code === 'ETIMEDOUT' || e.signal) return { failure: 'timeout' };
    if (/not a git repository/i.test(String(e.stderr ?? ''))) return { failure: 'not_repo' };
    return { failure: 'error' };
  }
}

const gitDidNotAnswer = (): FixLocation => ({ kind: 'rejected', reason: 'git did not answer in time (or failed) reading this checkout; try again' });

// @anchor fix-location
/**
 * Where a fix to a finding lives in the checkout at `workspacePath`, as mark_complete records it on an endorse
 * (SPEC §mark_complete). A fix commit postdates the finding (`recordedAt`, less FIX_SKEW_MS for clocks), since a
 * commit older than the finding cannot be its fix; with no recorded time no commit can be shown to.
 *
 * - `unknown`: not a git checkout.
 * - `absent`: a git checkout where none of `files` is known (not on disk, not tracked, and not in its history): not
 *   where the fix is. A file the fix deleted is in the history, so it is known.
 * - `untracked`: none of `files` is tracked or in the history, and every one on disk is ignored (.gitignore): no
 *   commit will hold the fix, so it is local to this checkout. Only when no fix commit is named. An untracked file
 *   that is not ignored is a file still to be committed: `uncommitted`, as any other change.
 * - `uncommitted`, before anything else, when one of the finding's files has changes git has not committed — even
 *   with a claimed commit, which must not paper over a fix that is not committed yet.
 * - `commit`: `claimed` — the agent named the fix commit, and it resolves here, is in HEAD's history and postdates
 *   the finding (`elsewhere` when it touches none of the finding's files), or predates it but touches its files
 *   (`predates`: a finding recorded after its fix was committed) — or else the newest commit since the
 *   finding touching its files. With its branch and whether a remote branch holds it; `awaitingMerge` (the branch
 *   it awaits, the origin's default branch when known) when every remote branch that holds it is a task branch
 *   (`<remote>/task/…`), which a review merges, so the fix is not integrated yet.
 * - `rejected`: the claimed commit fails one of those checks (`reason`).
 * - `uncommitted` also when, with no commit since the finding touching its files, other tracked files have
 *   uncommitted changes (`outside`: the fix may be among them). Changes count when modified, staged, untracked or
 *   deleted.
 * - `none`: no commit since the finding touches its files and nothing is uncommitted. A newer commit elsewhere is
 *   not taken as the fix — a pull of unrelated work would close every finding — but named (`newest`), so the agent
 *   can claim it when it is the fix.
 */
export type FixLocation = (
  | { kind: 'commit'; sha: string; branch?: string; pushed: boolean; elsewhere?: boolean; claimed?: boolean; predates?: boolean; awaitingMerge?: string }
  | { kind: 'uncommitted'; branch?: string; base?: string; outside?: boolean }
  | { kind: 'none'; newest?: { sha: string; files: string[] } }
  /** `claim`: the named fix_commit failed a check; otherwise the checkout could not be read. */
  | { kind: 'rejected'; reason: string; claim?: boolean }
  | { kind: 'absent' }
  | { kind: 'untracked' }
  | { kind: 'unknown' }
) & {
  /** The finding's files are in a clone nested in the checkout (a submodule, or `repos/<vessel>/` in the
   * super-repo): its path, relative to the checkout, where the fix was looked for. */
  nested?: string;
};

/** Allowance for the recording machine's clock running ahead of the committing machine's. */
export const FIX_SKEW_MS = 2 * 60_000;

/**
 * `head` is the ref a claimed commit must be in the history of: the checkout's `HEAD` by default; close by commit
 * passes the integration target (`origin/main`), since the fix is checked where it was merged.
 */
export function fixLocation(workspacePath: string, files: string[], recordedAt?: Date, fixCommit?: string, head = 'HEAD'): FixLocation {
  const cwd = resolve(workspacePath);
  const top = fgitTry(cwd, ['rev-parse', '--show-toplevel']);
  if ('failure' in top) return top.failure === 'not_repo' || top.failure === 'missing' ? { kind: 'unknown' } : gitDidNotAnswer();
  const named = files.map(f => f.trim()).filter(Boolean);
  // @anchor fix-location-nested
  // Files inside a nested clone (a submodule, or a vessel's clone under the super-repo's repos/) are that clone's: its
  // commits, its changes and its remote branches hold the fix, never the outer checkout's. SPEC §mark_complete
  const nested = nestedClone(cwd, top.out, named);
  if (nested) {
    const inner = fixLocation(nested, named.map(f => relative(nested, resolve(cwd, f)).split(sep).join('/')), recordedAt, fixCommit, head);
    const at = relative(cwd, nested).split(sep).join('/');
    if (inner.kind === 'rejected' && /is not a commit in this checkout/.test(inner.reason)) {
      return { ...inner, reason: `${fixCommit} is not a commit in the clone at ${at}; fetch there (git -C ${at} fetch) and endorse again`, nested: at };
    }
    return { ...inner, nested: at };
  }
  // Known to git: tracked now, or in the history (a file the fix deleted).
  const known = named.filter(f => !!fgit(cwd, ['ls-files', '--', f]) || !!fgit(cwd, ['log', '-1', '--format=%H', '--', f]));
  const paths = named.filter(f => known.includes(f) || existsSync(resolve(cwd, f)));
  if (!paths.length) return { kind: 'absent' };
  // git check-ignore answers by its exit status alone: 0 (an answer) when the path is ignored.
  const ignored = (f: string) => 'out' in fgitTry(cwd, ['check-ignore', '-q', '--', f]);
  if (!known.length && !fixCommit && paths.every(ignored)) return { kind: 'untracked' };
  const ref = fgit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = ref && ref !== 'HEAD' ? ref : undefined;
  const base = fgit(cwd, ['rev-parse', 'HEAD']) || undefined;
  const timed = !!recordedAt && Number.isFinite(recordedAt.getTime());
  const after = timed ? recordedAt!.getTime() - FIX_SKEW_MS : NaN;
  const commit = (sha: string, extra: { elsewhere?: boolean; claimed?: boolean; predates?: boolean } = {}): FixLocation => {
    const remotes = (fgit(cwd, ['branch', '-r', '--contains', sha]) ?? '').split('\n').map(b => b.trim()).filter(b => b && !b.includes(' -> '));
    // On task branches only, the fix awaits its merge, unless a task branch is the target itself (push_to: task with
    // integrate: push, where the push is the integration).
    const awaiting = remotes.length > 0 && remotes.every(b => /^[^/]+\/task\//.test(b)) && !/^[^/]+\/task\//.test(head);
    return { kind: 'commit', sha, branch, pushed: remotes.length > 0, ...extra, ...(awaiting ? { awaitingMerge: defaultBranch(cwd) } : {}) };
  };

  // Uncommitted changes in the finding's files come first, even over a claimed commit: a claim must not paper
  // over a fix that is not committed yet. A claim judged against another ref (close by commit, against the merge
  // target) is about that ref, and this checkout's working tree says nothing about it.
  if (!(fixCommit && head !== 'HEAD')) {
    const read = fgitTry(cwd, ['status', '--porcelain', '--untracked-files=all', '--', ...paths]);
    if ('failure' in read) return gitDidNotAnswer();
    if (read.out) return { kind: 'uncommitted', branch, base };
  }

  if (fixCommit) {
    const sha = fgit(cwd, ['rev-parse', '--verify', '--quiet', `${fixCommit}^{commit}`]);
    if (!sha) return { kind: 'rejected', reason: `${fixCommit} is not a commit in this checkout`, claim: true };
    if (fgit(cwd, ['merge-base', '--is-ancestor', sha, head]) === null) {
      return { kind: 'rejected', reason: head === 'HEAD' ? `${sha.slice(0, 10)} is not in this checkout's HEAD; endorse from a checkout that has it` : `${sha.slice(0, 10)} is not in ${head}`, claim: true };
    }
    if (!timed) return { kind: 'rejected', reason: 'the finding has no recorded time, so no commit can be shown to postdate it', claim: true };
    const at = Date.parse(fgit(cwd, ['show', '-s', '--format=%cI', sha]) ?? '');
    if (!Number.isFinite(at)) return { kind: 'rejected', reason: `the commit time of ${sha.slice(0, 10)} could not be read, so it cannot be shown to postdate the finding; try again`, claim: true };
    const touches = !!fgit(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha, '--', ...paths]);
    // A finding recorded after its fix was committed: the named commit is taken when it touches the finding's files.
    if (at < after) {
      if (!touches) return { kind: 'rejected', reason: `${sha.slice(0, 10)} predates the finding and touches none of its files, so it cannot be its fix`, claim: true };
      return commit(sha, { claimed: true, predates: true });
    }
    return commit(sha, { claimed: true, ...(touches ? {} : { elsewhere: true }) });
  }

  const since = timed ? [`--since=${new Date(after).toISOString()}`] : [];
  const touching = timed ? fgit(cwd, ['log', '-1', '--format=%H', ...since, '--', ...paths]) : null;
  if (touching) return commit(touching);
  if (fgit(cwd, ['status', '--porcelain', '--untracked-files=no'])) return { kind: 'uncommitted', branch, base, outside: true };
  const newest = timed ? fgit(cwd, ['log', '-1', '--format=%H', ...since]) : null;
  if (!newest) return { kind: 'none' };
  const changed = (fgit(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', newest]) ?? '').split('\n').filter(Boolean);
  return { kind: 'none', newest: { sha: newest, files: changed } };
}

/**
 * The clone nested in the checkout (top-level `top`) that holds every one of `files`, or null when they are the
 * checkout's own or spread over more than one repository. A file's repository is the top level git reports for the
 * nearest existing directory on its path.
 */
function nestedClone(cwd: string, top: string, files: string[]): string | null {
  if (!files.length) return null;
  const tops = new Set<string>();
  for (const f of files) {
    let dir = dirname(resolve(cwd, f));
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    tops.add(fgit(dir, ['rev-parse', '--show-toplevel']) ?? '');
  }
  if (tops.size !== 1) return null;
  const only = [...tops][0]!;
  return only && resolve(only) !== resolve(top) ? only : null;
}

/** Whether commit `sha` is in the history of the checkout's HEAD; null when the workspace is not a git checkout. */
export function commitInHead(workspacePath: string, sha: string): boolean | null {
  const cwd = resolve(workspacePath);
  if (fgit(cwd, ['rev-parse', '--show-toplevel']) === null) return null;
  // --is-ancestor answers through its exit code: 0 yes, 1 no, 128 when the commit is not in this clone at all.
  return fgit(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']) !== null;
}

/** The origin's default branch (`main` from `origin/HEAD`), or `its target` when the clone does not record one. */
function defaultBranch(cwd: string): string {
  const ref = fgit(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  return ref ? ref.replace(/^origin\//, '') : 'its target';
}

/** Whether the checkout at `workspacePath` has any remote: without one, no other checkout can have its commits. */
export function hasRemote(workspacePath: string): boolean {
  return !!fgit(resolve(workspacePath), ['remote']);
}

// @anchor repo-aliases
/**
 * The other ledger a workspace shares files with (SPEC §repository-identity). The substrate's super-repo and a
 * vessel's own checkout name the same file under two repositories and two paths: `repos/<vessel>/src/x.ts` in the
 * super-repo, `src/x.ts` in the vessel. Recall in either accepts the other's findings, with the paths mapped, by the
 * rule path_activity maps paths with (a `repos/` directory at the root is the super-repo; otherwise the vessel is
 * named by its origin's basename):
 * - `vessel`: this is a vessel checkout; findings recorded in a super-repo whose files sit under `repos/<name>/`
 *   are this checkout's, with that prefix removed;
 * - `super`: this is the super-repo; a vessel's own findings are its, with `repos/<name>/` added. A vessel directory
 *   that is its own git repository (a submodule or nested clone) is matched by its origin's exact identity; only one
 *   with no origin of its own is matched by name (a `repo:` whose last path segment is the directory's name).
 */
export type RepoAliases =
  | { kind: 'vessel'; name: string; prefix: string }
  | { kind: 'super'; vessels: ReadonlyMap<string, string | null> };

const aliasCache = new Map<string, RepoAliases | null>();

export function repoAliases(workspacePath: string): RepoAliases | null {
  const key = resolve(workspacePath);
  if (aliasCache.has(key)) return aliasCache.get(key)!;
  let out: RepoAliases | null = null;
  const top = git(key, ['rev-parse', '--show-toplevel']);
  const root = top ? real(top) : null;
  if (root && existsSync(join(root, 'repos'))) {
    try {
      const vessels = new Map<string, string | null>();
      for (const d of readdirSync(join(root, 'repos'), { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = join(root, 'repos', d.name);
        // Its own repository only when git's top level is the directory itself, not the super-repo around it.
        const ownTop = git(dir, ['rev-parse', '--show-toplevel']);
        const ownUrl = ownTop && real(ownTop) === real(dir) ? git(dir, ['remote', 'get-url', 'origin']) : null;
        vessels.set(d.name.toLowerCase(), ownUrl ? normalizeRemoteUrl(ownUrl, dir) : null);
      }
      out = { kind: 'super', vessels };
    } catch { /* unreadable repos/: no aliases */ }
  } else if (root) {
    const url = git(root, ['remote', 'get-url', 'origin']);
    const origin = url ? normalizeRemoteUrl(url, root) : null;
    out = origin ? vesselAliases(origin) : null;
  }
  aliasCache.set(key, out);
  return out;
}

/** A vessel checkout's aliases from its origin's identity alone, for a caller with no checkout yet (task pull). */
export function vesselAliases(originIdentity: string): RepoAliases | null {
  const name = basename(originIdentity).toLowerCase();
  return name ? { kind: 'vessel', name, prefix: `repos/${name}` } : null;
}
