/**
 * The plugin's edit check (scripts/claude-plugin/edit-check.mjs), run as Claude Code runs it: JSON on stdin, a decision on stdout.
 * Before the first edit of an existing file in a session it holds the edit once and asks for get_problems and
 * path_activity; a file already checked through either tool, a new file, a second edit, or METABOB_EDIT_CHECK=off
 * passes. README §claude-code-plugin
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dir, '..', '..', 'scripts', 'claude-plugin', 'edit-check.mjs');

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'editcheck-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'math.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'src', 'strings.ts'), 'export const y = 1;\n');
  const state = mkdtempSync(join(tmpdir(), 'editcheck-state-'));
  // An attached server's marker for the repo (src/attached-marker.ts): this process stands in for the server.
  attach(repo, state);
  return { repo, state, session: `s-${Math.random().toString(36).slice(2)}` };
}

function markerFile(dir: string, markerDir: string): string {
  const tag = createHash('sha256').update(realpathSync.native(dir)).digest('hex').slice(0, 16);
  return join(markerDir, `metabob-attached-${tag}.json`);
}

function attach(dir: string, markerDir: string, marker: Record<string, unknown> = { pid: process.pid, orgId: 'org', at: new Date().toISOString() }) {
  writeFileSync(markerFile(dir, markerDir), JSON.stringify(marker));
}

function hook(mode: 'pre' | 'post', input: unknown, env: Record<string, string>) {
  const r = spawnSync('node', [HOOK, mode], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf-8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { status: r.status, out: r.stdout.trim() };
}

const edit = (s: ReturnType<typeof setup>, file: string, tool = 'Edit') =>
  ({ session_id: s.session, cwd: s.repo, tool_name: tool, tool_input: { file_path: file } });

describe('edit check', () => {
  test('holds the first edit of a file once, with the checks to run, then lets it through', () => {
    const s = setup();
    const env = { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: s.state };
    const first = hook('pre', edit(s, 'src/math.ts'), env);
    expect(first.status).toBe(0);
    const decision = JSON.parse(first.out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toStartWith('Held, not an error. metabob: before editing src/math.ts, call get_problems for it and path_activity on it');
    expect(decision.permissionDecisionReason).toContain('record_finding');
    expect(hook('pre', edit(s, 'src/math.ts'), env).out).toBe('');
    // Another file is held once too.
    expect(JSON.parse(hook('pre', edit(s, `${s.repo}/src/strings.ts`, 'Write'), env).out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('a file already checked with path_activity or get_problems is not held', () => {
    const s = setup();
    const env = { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: s.state };
    hook('post', { session_id: s.session, cwd: s.repo, tool_name: 'mcp__plugin_metabob_metabob__path_activity', tool_input: { paths: ['src'] } }, env);
    expect(hook('pre', edit(s, 'src/math.ts'), env).out).toBe('');
    const t = setup();
    const env2 = { METABOB_EDIT_CHECK_DIR: t.state, METABOB_MARKER_DIR: t.state };
    hook('post', { session_id: t.session, cwd: t.repo, tool_name: 'mcp__metabob__get_problems', tool_input: { file_path: 'src/strings.ts' } }, env2);
    expect(hook('pre', edit(t, 'src/strings.ts'), env2).out).toBe('');
    expect(hook('pre', edit(t, 'src/math.ts'), env2).out).not.toBe('');
  });

  test('a path checked in the gap store\'s repos/<vessel>/… form counts for the local file', () => {
    const s = setup();
    const vessel = join(s.repo, 'repos', 'goal-host-vessel', 'src');
    mkdirSync(vessel, { recursive: true });
    writeFileSync(join(vessel, 'index.ts'), 'x\n');
    const env = { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: s.state };
    hook('post', { session_id: s.session, cwd: '/elsewhere', tool_input: { paths: ['repos/goal-host-vessel/src/index.ts'] } }, env);
    expect(hook('pre', edit(s, join(vessel, 'index.ts')), env).out).toBe('');
  });

  test('a new file, a disabled check, another session\'s state, and bad input never hold an edit', () => {
    const s = setup();
    const env = { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: s.state };
    expect(hook('pre', edit(s, 'src/new-file.ts', 'Write'), env).out).toBe('');
    expect(hook('pre', edit(s, 'src/math.ts'), { ...env, METABOB_EDIT_CHECK: 'off' }).out).toBe('');
    const bad = hook('pre', 'not json', env);
    expect(bad.status).toBe(0);
    expect(bad.out).toBe('');
    // Sessions do not share state: a fresh session is held on its own first edit.
    hook('pre', edit(s, 'src/math.ts'), env);
    expect(hook('pre', { ...edit(s, 'src/math.ts'), session_id: 'other' }, env).out).not.toBe('');
  });

  test('the plugin manifest points at the hooks, and they wire the edit tools and the two checking tools', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, '..', '..', '.claude-plugin', 'plugin.json'), 'utf-8'));
    expect(manifest.hooks).toBe('./scripts/claude-plugin/hooks.json');
    const hooks = JSON.parse(readFileSync(resolve(import.meta.dir, '..', '..', 'scripts', 'claude-plugin', 'hooks.json'), 'utf-8')).hooks;
    expect(hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/claude-plugin/edit-check.mjs" pre');
    expect(new RegExp(`^(?:${hooks.PostToolUse[0].matcher})$`).test('mcp__plugin_metabob_metabob__path_activity')).toBe(true);
    expect(new RegExp(`^(?:${hooks.PostToolUse[0].matcher})$`).test('mcp__metabob__get_problems')).toBe(true);
  });

  // With no attached server there is no shared ledger behind the check: a plugin installed before a key is set,
  // a rejected key, or no server at all holds nothing.
  test('holds nothing unless a live, recent attached marker covers the directory', () => {
    const s = setup();
    const noMarker = mkdtempSync(join(tmpdir(), 'editcheck-nomarker-'));
    expect(hook('pre', edit(s, 'src/math.ts'), { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: noMarker }).out).toBe('');
    const stale = mkdtempSync(join(tmpdir(), 'editcheck-stale-'));
    attach(s.repo, stale, { pid: process.pid, orgId: 'org', at: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(hook('pre', edit(s, 'src/math.ts'), { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: stale }).out).toBe('');
    const dead = mkdtempSync(join(tmpdir(), 'editcheck-dead-'));
    attach(s.repo, dead, { pid: 2 ** 22 + 12345, orgId: 'org', at: new Date().toISOString() });
    expect(hook('pre', edit(s, 'src/math.ts'), { METABOB_EDIT_CHECK_DIR: s.state, METABOB_MARKER_DIR: dead }).out).toBe('');
    // A marker for an ancestor of the session's directory covers it.
    const t = setup();
    const sub = join(t.repo, 'src');
    expect(hook('pre', { ...edit(t, 'math.ts'), cwd: sub }, { METABOB_EDIT_CHECK_DIR: t.state, METABOB_MARKER_DIR: t.state }).out).not.toBe('');
  });
});
