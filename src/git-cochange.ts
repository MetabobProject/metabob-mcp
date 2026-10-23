import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';

/**
 * Git-history co-change mining: which files actually changed together with
 * the given files, measured over the repository's commit history.
 *
 * This is the co-change signal of predict_cochanges, assign_git_changes,
 * get_analysis_context and init_workspace. It needs no index, and it covers
 * files with no function/class components (schemas, configs, constants).
 */

export interface GitCochangePrediction {
  filePath: string;
  /** P(file changed | changed_file changed) over the mined window. */
  confidence: number;
  /** Number of commits in which the pair co-occurred. */
  cooccurrences: number;
}

const MAX_COMMITS = 500;
/** Commits touching more files than this are bulk moves/reformats — skip. */
const MAX_FILES_PER_COMMIT = 30;

function gitLogNameOnly(workspaceRoot: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', workspaceRoot, 'log', '--name-only', '--pretty=format:%H', `-n`, String(MAX_COMMITS)],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolvePromise(err ? null : stdout),
    );
  });
}

/**
 * Mine co-change predictions for `changedFiles` (workspace-relative or
 * absolute paths) from the git history at `workspaceRoot`. Returns
 * predictions sorted by confidence, excluding the input files themselves.
 * Resolves to [] when the workspace is not a git repository.
 */
export async function mineGitCochanges(
  workspaceRoot: string,
  changedFiles: string[],
  limit: number,
): Promise<GitCochangePrediction[]> {
  const log = await gitLogNameOnly(workspaceRoot);
  if (!log) return [];

  // git log emits forward-slash paths on every platform; path.relative()
  // uses backslashes on Windows — normalize so the lookup matches.
  const targets = new Set(
    changedFiles.map((f) =>
      relative(workspaceRoot, resolve(workspaceRoot, f)).replace(/\\/g, '/'),
    ),
  );

  // Parse commits: hash line, then file lines, separated by blank lines.
  const commits: string[][] = [];
  let current: string[] = [];
  for (const line of log.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      if (current.length > 0) commits.push(current);
      current = [];
    } else if (line.trim().length > 0) {
      current.push(line.trim());
    }
  }
  if (current.length > 0) commits.push(current);

  let targetCommits = 0;
  const cooccurrence = new Map<string, number>();

  for (const files of commits) {
    if (files.length > MAX_FILES_PER_COMMIT) continue;
    const touchesTarget = files.some((f) => targets.has(f));
    if (!touchesTarget) continue;
    targetCommits += 1;
    for (const f of files) {
      if (targets.has(f)) continue;
      cooccurrence.set(f, (cooccurrence.get(f) ?? 0) + 1);
    }
  }

  if (targetCommits === 0) return [];

  return [...cooccurrence.entries()]
    .map(([filePath, count]) => ({
      filePath,
      confidence: count / targetCommits,
      cooccurrences: count,
    }))
    .sort((a, b) => b.confidence - a.confidence || b.cooccurrences - a.cooccurrences)
    .slice(0, limit);
}
