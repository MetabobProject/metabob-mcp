/**
 * Filesystem watcher for sidecar mode.
 *
 * Uses Node/Bun's native `fs.watch()` with `recursive: true` to detect
 * file changes in the workspace root, debounces 500ms, then enqueues
 * changed paths at priority P1 in the schedule queue.
 */

import { watch } from 'fs';
import { join, extname, relative } from 'path';
import type { LocalStore } from './local-store.js';

// ── Skip rules ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache']);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.ogg', '.mp3', '.wav',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z',
  '.pdf', '.bin', '.exe', '.dll', '.so', '.dylib',
  '.lock',
]);

function shouldSkip(filePath: string): boolean {
  // Check directory segments
  const parts = filePath.split(/[\\/]/);
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  // Check extension
  const ext = extname(filePath).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

// ── Debounce ──────────────────────────────────────────────────────────────────

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as T;
}

// ── startWatcher ──────────────────────────────────────────────────────────────

/**
 * Start watching `workspaceRoot` for file changes.
 *
 * Returns a cleanup function that stops the watcher.
 */
export function startWatcher(
  workspaceRoot: string,
  store: LocalStore,
  workspaceId: string,
): () => void {
  // Collect changed paths before debounced flush
  const pendingPaths = new Set<string>();

  const flush = debounce(() => {
    const paths = [...pendingPaths];
    pendingPaths.clear();
    for (const p of paths) {
      try {
        store.enqueue(p, 1 /* P1 */, workspaceId);
      } catch {
        // Non-fatal — store may be closed during shutdown
      }
    }
  }, 500);

  let watcher: ReturnType<typeof watch> | null = null;

  try {
    watcher = watch(workspaceRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;

      // Normalise to an absolute path
      const absPath = filename.startsWith('/')
        ? filename
        : join(workspaceRoot, filename);

      // Relative for skip check
      const rel = relative(workspaceRoot, absPath);
      if (shouldSkip(rel)) return;

      pendingPaths.add(absPath);
      flush();
    });

    watcher.on('error', (_err) => {
      // Watcher errors (e.g. ENOSPC) are non-fatal — sidecar degrades gracefully.
    });
  } catch {
    // fs.watch may fail on unsupported filesystems (e.g. some network mounts).
    // Return a no-op cleanup.
    return () => {};
  }

  return () => {
    try {
      watcher?.close();
    } catch {
      // ignore
    }
  };
}
