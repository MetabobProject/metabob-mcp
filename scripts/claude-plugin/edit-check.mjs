#!/usr/bin/env node
// Contract (behaviour): README §claude-code-plugin
/**
 * The plugin's edit check. Before an agent's first edit of an existing file in a session, the edit is held
 * once, with the reason: check what other agents recorded and what the substrate has in flight on that file
 * (get_problems, path_activity), then retry. Text guidance alone did not change behaviour on edit tasks
 * (0 of 4 runs touched the ledger); holding the first edit once did (3 of 3 checked before the edit landed).
 *
 *   node edit-check.mjs pre    PreToolUse on Edit / Write / MultiEdit / NotebookEdit
 *   node edit-check.mjs post   PostToolUse on the metabob get_problems / path_activity tools: the files they
 *                              named count as checked, so a file the agent already checked is never held
 *
 * In a repository the substrate does not mount there is nothing in flight to check: when path_activity answers
 * that the repository is not one the substrate mounts (src/tools/path-activity.ts@unmounted-repo), the session's
 * directory is recorded as unmounted, and a later hold there asks for get_problems only.
 *
 * Held at most once per file per session, and only when the metabob server is attached for this directory or an
 * ancestor (src/attached-marker.ts writes the marker): with no key, a rejected key or no server, there is no shared
 * ledger behind the check, so nothing is held. A new file (a Write to a path that does not exist) is not held:
 * there is nothing recorded on it. METABOB_EDIT_CHECK=off turns the check off. Any error lets the edit through: the
 * check must never stop an agent from working.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const OFF = /^(off|0|false|no)$/i;
/** path_activity's answer for a repository the substrate does not mount (src/tools/path-activity.ts@unmounted-repo). */
const UNMOUNTED = /may not be a repository this substrate mounts/;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** This session's state file: one line per entry, `held <path>`, `checked <path>` or `unmounted <dir>`. */
function stateFile(sessionId) {
  const tag = createHash('sha256').update(String(sessionId ?? 'no-session')).digest('hex').slice(0, 16);
  return join(process.env.METABOB_EDIT_CHECK_DIR || tmpdir(), `metabob-edit-check-${tag}`);
}

function readState(file) {
  const sets = { held: new Set(), checked: new Set(), unmounted: new Set() };
  if (!existsSync(file)) return sets;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf(' ');
    if (i < 0) continue;
    (sets[line.slice(0, i)] ?? sets.checked).add(line.slice(i + 1));
  }
  return sets;
}

/** A path as forward slashes, absolute against the session's working directory. */
function norm(p, cwd) {
  const abs = isAbsolute(p) ? p : resolve(cwd || process.cwd(), p);
  return abs.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Whether `file` was checked: named itself, under a checked directory, or matched by a `repos/<vessel>/…` form. */
function wasChecked(file, checked) {
  for (const c of checked) {
    if (file === c || file.startsWith(`${c}/`)) return true;
    const rel = c.replace(/^.*?\/(repos\/[^/]+\/)/, '$1');
    if (rel.startsWith('repos/') && (file.endsWith(`/${rel}`) || file.includes(`/${rel}/`))) return true;
  }
  return false;
}

/** The attached marker for `dir`, named as src/attached-marker.ts names it. */
function markerFor(dir) {
  const tag = createHash('sha256').update(dir).digest('hex').slice(0, 16);
  return join(process.env.METABOB_MARKER_DIR || tmpdir(), `metabob-attached-${tag}.json`);
}

/** The directory (`cwd` or an ancestor) a live metabob server is attached for, or null: a recent marker whose process is alive. */
function attachedRoot(cwd) {
  let dir = resolve(cwd || process.cwd());
  try { dir = realpathSync.native(dir); } catch { /* not on disk */ }
  for (;;) {
    try {
      const file = markerFor(dir);
      // Only this user's marker counts: another user on a shared host could plant one.
      if (typeof process.getuid === 'function' && statSync(file).uid !== process.getuid()) throw new Error('not ours');
      const m = JSON.parse(readFileSync(file, 'utf8'));
      const fresh = Date.now() - Date.parse(m.at) < 5 * 60_000;
      let alive = false;
      try { process.kill(m.pid, 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
      if (fresh && alive) return dir;
    } catch { /* no marker here */ }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function pre(input) {
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.notebook_path;
  if (!target) return;
  const cwd = input.cwd;
  const file = norm(String(target), cwd);
  // A new file has nothing recorded on it.
  if (!existsSync(isAbsolute(String(target)) ? String(target) : resolve(cwd || process.cwd(), String(target)))) return;
  // With no attached server there is no shared ledger to check: hold nothing. And only a file inside the attached
  // workspace has a ledger behind it: a file elsewhere (a cache, a temp file, another checkout) is never held.
  const root = attachedRoot(cwd);
  if (!root) return;
  let real = file;
  try { real = realpathSync.native(isAbsolute(String(target)) ? String(target) : resolve(cwd || process.cwd(), String(target))).replace(/\\/g, '/'); } catch { /* new or unreadable: as given */ }
  const rootN = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (real !== rootN && !real.startsWith(`${rootN}/`)) return;
  const state = stateFile(input.session_id);
  const { held, checked, unmounted } = readState(state);
  if (held.has(file) || wasChecked(file, checked)) return;
  appendFileSync(state, `held ${file}\n`);
  const local = [...unmounted].some((d) => file === d || file.startsWith(`${d}/`));
  const reason = [
    local
      ? `Held, not an error. metabob: before editing ${target}, call get_problems for it: other agents may have recorded problems on it.`
        + ' (path_activity is not needed here: the substrate does not mount this repository, so nothing is in flight on it.)'
      : `Held, not an error. metabob: before editing ${target}, call get_problems for it and path_activity on it: other agents may have recorded`
        + ' problems on it, and the substrate may have work in flight there.',
    'If you notice a problem you are not fixing,',
    'record_finding it; a bug mentioned only in your reply is lost to the next agent. Then retry this edit: it is held',
    'once per file, only so the check happens first (METABOB_EDIT_CHECK=off turns this off).',
  ].join(' ');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

function post(input) {
  const ti = input.tool_input || {};
  const named = [];
  if (Array.isArray(ti.paths)) named.push(...ti.paths);
  for (const k of ['file_path', 'file', 'path']) if (typeof ti[k] === 'string') named.push(ti[k]);
  const state = stateFile(input.session_id);
  if (named.length) appendFileSync(state, named.map((p) => `checked ${norm(String(p), input.cwd)}\n`).join(''));
  // The response shape differs by client version (a string, content blocks), so search its serialized form.
  if (/path_activity$/.test(String(input.tool_name ?? '')) && UNMOUNTED.test(JSON.stringify(input.tool_response ?? ''))) {
    appendFileSync(state, `unmounted ${norm('.', input.cwd)}\n`);
  }
}

try {
  if (!OFF.test(process.env.METABOB_EDIT_CHECK ?? '')) {
    const input = readInput();
    if (input) (process.argv[2] === 'post' ? post : pre)(input);
  }
} catch {
  // Never stop an agent from working because the check failed.
}
