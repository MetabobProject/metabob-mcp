/**
 * Git event listener for sidecar mode.
 *
 * Polls `.git/HEAD` and `git status --porcelain` every 5 seconds.
 * On HEAD change (new commit): enqueues ALL tracked modified files as P1.
 * On working-tree change: enqueues changed files as P1.
 * Skips gracefully when `.git` does not exist.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { LocalStore } from './local-store.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function readHead(gitDir: string): string {
  try {
    const headFile = join(gitDir, 'HEAD');
    // Use spawnSync to read HEAD — avoids fs.readFileSync import complexity
    const result = spawnSync('cat', [headFile], { encoding: 'utf8' });
    if (result.status !== 0) return '';
    const ref = result.stdout.trim();
    // Dereference symbolic refs to the actual SHA
    if (ref.startsWith('ref: ')) {
      const refPath = ref.slice(5).trim();
      const r2 = spawnSync('cat', [join(gitDir, refPath)], { encoding: 'utf8' });
      return r2.status === 0 ? r2.stdout.trim() : ref;
    }
    return ref;
  } catch {
    return '';
  }
}

function gitStatusFiles(workspaceRoot: string): string[] {
  try {
    const result = execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return result
      .split('\n')
      .filter(l => l.length > 2)
      .map(l => {
        // Format: XY path  or  XY old -> new
        const raw = l.slice(3).trim();
        // Handle rename: "old -> new" — take the destination
        const arrowIdx = raw.indexOf(' -> ');
        return arrowIdx !== -1 ? raw.slice(arrowIdx + 4).trim() : raw;
      })
      .filter(Boolean)
      .map(f => join(workspaceRoot, f));
  } catch {
    return [];
  }
}

function gitTrackedModifiedFiles(workspaceRoot: string): string[] {
  try {
    const result = execSync('git diff --name-only HEAD', {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return result
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(f => join(workspaceRoot, f));
  } catch {
    return [];
  }
}

// ── startGitWatcher ───────────────────────────────────────────────────────────

/**
 * Start polling git state at 5s cadence.
 *
 * Returns a cleanup function that stops the polling interval.
 */
export function startGitWatcher(
  workspaceRoot: string,
  store: LocalStore,
  workspaceId: string,
): () => void {
  const gitDir = join(workspaceRoot, '.git');
  if (!existsSync(gitDir)) {
    // Not a git workspace — return no-op
    return () => {};
  }

  let lastHead = readHead(gitDir);
  // Snapshot of the working-tree status lines on last poll
  let lastStatusSet = new Set<string>(gitStatusFiles(workspaceRoot));

  const interval = setInterval(() => {
    try {
      const currentHead = readHead(gitDir);

      if (currentHead !== lastHead && currentHead !== '') {
        // A new commit landed — enqueue all tracked modified files
        const files = gitTrackedModifiedFiles(workspaceRoot);
        for (const f of files) {
          try {
            store.enqueue(f, 1 /* P1 */, workspaceId);
          } catch {
            // store closed during shutdown
          }
        }
        lastHead = currentHead;
        // Reset working-tree snapshot after commit
        lastStatusSet = new Set(gitStatusFiles(workspaceRoot));
        return;
      }

      // Check for working-tree changes (new, modified, deleted paths)
      const currentFiles = gitStatusFiles(workspaceRoot);
      const currentSet = new Set(currentFiles);

      const added: string[] = [];
      for (const f of currentSet) {
        if (!lastStatusSet.has(f)) added.push(f);
      }

      for (const f of added) {
        try {
          store.enqueue(f, 1 /* P1 */, workspaceId);
        } catch {
          // store closed
        }
      }

      lastStatusSet = currentSet;
    } catch {
      // Polling errors are non-fatal
    }
  }, 5000);

  return () => {
    clearInterval(interval);
  };
}
