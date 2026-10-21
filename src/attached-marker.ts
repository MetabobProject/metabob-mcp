// Contract (behaviour): README §claude-code-plugin
/**
 * The attached marker: while this server is attached to a substrate, a small file in the temp directory says so
 * for its workspace, so the Claude Code plugin's edit check (scripts/claude-plugin/edit-check.mjs) holds an edit
 * only where there is a shared ledger behind it. A plugin installed before a key is configured, or a key that is
 * rejected, holds nothing.
 *
 * The file is `metabob-attached-<sha256(real workspace path)[:16]>.json` holding `{ pid, orgId, at }`. It is
 * written when the attachment authenticates, refreshed every minute while it stays authenticated, and removed when
 * it stops being authenticated or the process exits. The edit check trusts it only while `pid` is alive and `at` is
 * recent. METABOB_MARKER_DIR moves it (tests).
 */

import { createHash } from 'node:crypto';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Attachment } from './attachment.js';

const REFRESH_MS = 60_000;

/** The marker's path for `workspace`; the edit check computes the same name. */
export function markerPath(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  let real = resolve(workspace);
  try { real = realpathSync.native(real); } catch { /* not on disk: its resolved form */ }
  const tag = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return join(env.METABOB_MARKER_DIR || tmpdir(), `metabob-attached-${tag}.json`);
}

/**
 * Keep the marker for `workspace` in step with `attachment`: present while it is authenticated, absent otherwise.
 * Returns a stop function that removes the marker.
 */
export function keepAttachedMarker(attachment: Attachment, workspace: string, env: NodeJS.ProcessEnv = process.env): () => void {
  const file = markerPath(workspace, env);
  const sync = () => {
    try {
      const auth = attachment.state().auth;
      if (auth.status === 'authenticated') {
        writeFileSync(file, JSON.stringify({ pid: process.pid, orgId: auth.orgId ?? null, at: new Date().toISOString() }));
      } else {
        rmSync(file, { force: true });
      }
    } catch { /* the marker is a convenience for the edit check, never a reason to fail */ }
  };
  void attachment.settled().then(sync, sync);
  const timer = setInterval(sync, REFRESH_MS);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    try { rmSync(file, { force: true }); } catch { /* already gone */ }
  };
  process.once('exit', stop);
  return stop;
}
