/**
 * Workspace identity helpers.
 *
 * resolveWorkspaceId() produces a stable opaque identifier for a workspace
 * directory by combining its path with the repo's first commit hash (when
 * available). Callers use this as the partition key in the local SQLite store.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';

/**
 * Return a hex SHA-256 that uniquely identifies a workspace root.
 *
 * Strategy:
 *  1. Run `git rev-list --max-parents=0 HEAD` inside rootPath.
 *  2. Hash SHA-256( rootPath + firstCommit ).
 *  3. Fallback if git is absent or not a repo: SHA-256( rootPath ).
 */
export async function resolveWorkspaceId(rootPath: string): Promise<string> {
  let firstCommit = '';
  try {
    firstCommit = execSync('git rev-list --max-parents=0 HEAD', {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git repo or git not available — fall through with empty string.
  }

  return createHash('sha256')
    .update(rootPath + firstCommit)
    .digest('hex');
}
