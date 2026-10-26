/**
 * Work that changes no file (SPEC §record_finding, SPEC §mark_complete): a task names a subject instead of files, is
 * recalled and claimed like any other, and closes on endorse with its outcome; a task that names files still closes
 * only by its commit. `task pull` takes a file-less task too. SPEC §task-pull
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, entryUnderTest, makeWorkspace, tempDir } from './harness/mcp-client';
import { normalizeRemoteUrl } from '../../src/repo-identity';

setDefaultTimeout(60_000);

let fake: FakeSubstrate;
let server: McpServer;
let ws: string;

const contents = (shape: string) => fake.state.concepts.filter((c) => c.shape === shape).map((c) => String(c.content ?? ''));

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  ws = makeWorkspace('no-edit');
  const git = (...args: string[]) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'one');
  server = await McpServer.start({ workspace: ws, env: fake.env() });
});

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  cleanupTempDirs();
});

describe('a task that changes no file', () => {
  let id = '';

  test('records with a subject and no files', async () => {
    const out = await server.text('record_finding', {
      subject: 'github#12: the login test is flaky on CI',
      summary: 'triage the flaky login test',
      severity: 'MEDIUM',
      category: 'task',
      details: 'Goal: say whether it reproduces on main. Done when: the issue has a triage comment.',
    });
    id = /subject: .*→\s+(agf_\w+)/.exec(out)?.[1] ?? '';
    expect(id).not.toBe('');
    const finding = contents('code_finding').at(-1)!;
    expect(finding).toMatch(/^subject: github#12: the login test is flaky on CI$/m);
    expect(finding).not.toMatch(/^files:/m);
  });

  test('is listed with its subject, and claimed', async () => {
    const problems = await server.text('get_problems');
    expect(problems).toContain('triage the flaky login test');
    expect(problems).toContain('subject: github#12: the login test is flaky on CI');
    expect(await server.text('claim_finding', { problem_id: id, minutes: 30 })).toMatch(/Claimed finding|not settled/);
  });

  test('closes on endorse with its outcome and evidence, with no commit', async () => {
    const out = await server.text('mark_complete', {
      problem_id: id,
      outcome: 'not reproducible on main in 20 runs; the flake is a CI runner timeout',
      evidence: ['https://github.com/org/repo/issues/12#issuecomment-1'],
    });
    expect(out).toContain('endorsed (finding resolved');
    expect(out).toContain('outcome: not reproducible on main in 20 runs');
    expect(out).not.toContain('fix pending');
    const verdict = contents('finding_verdict').find((c) => c.includes(`finding: ${id}`) && c.includes('endorsed'))!;
    expect(verdict).toMatch(/^outcome: not reproducible on main in 20 runs; the flake is a CI runner timeout$/m);
    expect(verdict).toMatch(/^evidence: https:\/\/github\.com\/org\/repo\/issues\/12#issuecomment-1$/m);
    expect(verdict).not.toMatch(/^fix:/m);
    expect(verdict).not.toMatch(/^files:/m);
  });

  test('reads as done, with the outcome, in the closed tasks', async () => {
    const problems = await server.text('get_problems');
    expect(problems).toMatch(/\[DONE\] .*triage the flaky login test/);
    expect(problems).toContain('outcome: not reproducible on main in 20 runs');
  });

  test('a finding needs files or a subject', async () => {
    const r = await server.call('record_finding', { summary: 'about nothing', severity: 'LOW', category: 'task' });
    expect(r.error?.message ?? r.text).toMatch(/files, or a subject/);
  });
});

describe('a task that names files', () => {
  test('an outcome does not close it while its files have uncommitted changes', async () => {
    const out = await server.text('record_finding', { files: ['src/index.ts'], summary: 'answer is wrong', severity: 'LOW', category: 'task' });
    const id = /src\/index\.ts\s+→\s+(agf_\w+)/.exec(out)?.[1] ?? '';
    writeFileSync(join(ws, 'src/index.ts'), 'export const answer = 43;\n');
    const closed = await server.text('mark_complete', { problem_id: id, outcome: 'set the answer to 43' });
    expect(closed).toContain('fix pending');
    expect(closed).not.toContain('endorsed (finding resolved');
  });
});

test('task pull takes a file-less task and says how it closes', async () => {
  const root = tempDir('w15');
  const bare = join(root, 'lambda.git');
  const seed = join(root, 'seed');
  const git = (...a: string[]) => spawnSync('git', a, { stdio: 'ignore' });
  git('init', '-q', '--bare', '-b', 'main', bare);
  git('init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README.md'), 'lambda\n');
  git('-C', seed, 'add', '.');
  git('-C', seed, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'seed');
  git('-C', seed, 'push', '-q', bare, 'main');
  const at = new Date(Date.now() - 3_600_000).toISOString();
  fake.state.concepts.push({
    id: 'concept_w15task', shape: 'code_finding', source_type: 'metabob_annotation', created_at: at, updated_at: at,
    summary: '[HIGH][task] lambda: review the release checklist', times_loaded: 0, times_succeeded: 0, times_failed: 0,
    content: `repo: ${normalizeRemoteUrl(bare)}\nsubject: docs/RELEASE.md process, against the last release\nseverity: HIGH\ncategory: task\nfinding_ids: agf_w15task\nrecorded_by: coordinator-w15\n\nSay which steps the last release skipped.`,
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(METABOB_|MB_|DISCOVERY_ENDPOINT|IDENTITY_|VESSEL_|SESSION_|WORKSPACE_PATH)/.test(k)) env[k] = v;
  }
  const home = tempDir('w15-home');
  Object.assign(env, { HOME: home, USERPROFILE: home, METABOB_API_KEY: 'mb_test_workflow_key', METABOB_NO_SYSTEM_CA: '1', VESSEL_ID: 'metabob-mcp-cellw15', ...fake.env() });
  const taskDir = join(tempDir('w15-task'), 'task');
  const workDir = join(tempDir('w15-work'), 'work');
  const runtime = process.env.MCP_UNDER_TEST === 'dist' ? 'node' : 'bun';
  const child = spawn(runtime, [entryUnderTest(), 'task', 'pull', '--origin', bare, '--task-dir', taskDir, '--work-dir', workDir, '--json'], { env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const status = await new Promise<number | null>((done) => child.on('close', done));
  expect(stderr).not.toContain('fatal');
  expect(status).toBe(0);
  const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'));
  expect(task).toMatchObject({ task_id: 'agf_w15task', files: [], subject: 'docs/RELEASE.md process, against the last release' });
  const context = readFileSync(join(taskDir, 'context.md'), 'utf8');
  expect(context).toContain('Subject: docs/RELEASE.md process, against the last release');
  expect(context).toContain('close it with mark_complete endorse and its outcome');
  expect(context).not.toContain('## Open findings on these files');
});
