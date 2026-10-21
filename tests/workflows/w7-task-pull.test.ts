/**
 * W7 — a cell's entrypoint takes its task (docs/proposals/agent-cell-lab.md §4.1): `metabob-mcp task pull` as a
 * separate process against the fake substrate, claims the ledger task, writes /task and clones /work. With
 * MCP_UNDER_TEST=dist it runs the built CLI under node, as `npx @metabob/mcp` does in a cell. SPEC §task-pull
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeSubstrate } from './harness/fake-substrate';
import { cleanupTempDirs, entryUnderTest, tempDir } from './harness/mcp-client';
import { normalizeRemoteUrl } from '../../src/repo-identity';

setDefaultTimeout(60_000);

let fake: FakeSubstrate;
let bare: string;

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  const root = tempDir('w7');
  bare = join(root, 'kappa.git');
  const seed = join(root, 'seed');
  const git = (...a: string[]) => spawnSync('git', a, { stdio: 'ignore' });
  git('init', '-q', '--bare', '-b', 'main', bare);
  git('init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'stats.ts'), 'export const average = (xs: number[]) => xs.length;\n');
  git('-C', seed, 'add', '.');
  git('-C', seed, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'seed');
  git('-C', seed, 'push', '-q', bare, 'main');
  const now = new Date(Date.now() - 3_600_000).toISOString();
  fake.state.concepts.push({
    id: 'concept_w7task', shape: 'code_finding', source_type: 'metabob_annotation', created_at: now, updated_at: now,
    summary: '[HIGH][task] kappa: fix average()', times_loaded: 0, times_succeeded: 0, times_failed: 0,
    content: `repo: ${normalizeRemoteUrl(bare)}\nfiles: stats.ts\nseverity: HIGH\ncategory: task\nfinding_ids: agf_w7task\nrecorded_by: coordinator-w7\n\naverage() divides by nothing.\npush_to: main`,
  });
});

afterAll(async () => {
  await fake?.stop();
  cleanupTempDirs();
});

/** Run the CLI as its own process. Asynchronously: the fake substrate is served from this process's event loop. */
async function pull(extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(METABOB_|MB_|DISCOVERY_ENDPOINT|IDENTITY_|VESSEL_|SESSION_|WORKSPACE_PATH)/.test(k)) env[k] = v;
  }
  const home = tempDir('w7-home');
  Object.assign(env, { HOME: home, USERPROFILE: home, METABOB_API_KEY: 'mb_test_workflow_key', METABOB_NO_SYSTEM_CA: '1', VESSEL_ID: 'metabob-mcp-cellw7', ...fake.env(), ...extraEnv });
  const runtime = process.env.MCP_UNDER_TEST === 'dist' ? 'node' : 'bun';
  const taskDir = join(tempDir('w7-task'), 'task');
  const workDir = join(tempDir('w7-work'), 'work');
  const child = spawn(runtime, [entryUnderTest(), 'task', 'pull', '--origin', bare, '--task-dir', taskDir, '--work-dir', workDir, '--json'], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const status = await new Promise<number | null>(done => child.on('close', done));
  return { status, stdout, stderr, taskDir, workDir };
}

test('task pull claims the ledger task, writes /task and clones /work', async () => {
  const r = await pull();
  expect(r.stderr).not.toContain('fatal');
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
  expect(out).toMatchObject({ code: 0, task: { task_id: 'agf_w7task', policy: { push_to: 'main', source: { push_to: 'task' } } } });
  const task = JSON.parse(readFileSync(join(r.taskDir, 'task.json'), 'utf8'));
  expect(task.claim.by).toBe('metabob-mcp-cellw7');
  expect(existsSync(join(r.workDir, 'stats.ts'))).toBe(true);
  const claims = fake.state.concepts.filter(c => c.shape === 'finding_verdict' && c.content.includes('verdict: claimed'));
  expect(claims).toHaveLength(1);
  expect(claims[0]!.content).toContain('reviewed_by: metabob-mcp-cellw7');
});

test('a second cell finds the task held and exits 4 with the claim end', async () => {
  const r = await pull({ VESSEL_ID: 'metabob-mcp-cellw7b' });
  expect(r.status).toBe(4);
  expect(JSON.parse(r.stderr.trim().split('\n').pop()!)).toMatchObject({ code: 4 });
  expect(existsSync(r.taskDir)).toBe(false);
});
