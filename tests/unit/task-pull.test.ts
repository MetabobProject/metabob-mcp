/**
 * `metabob-mcp task pull` (SPEC §task-pull): a cell's entrypoint takes a task from the ledger, claims it, writes
 * /task and clones /work, so every harness gets its work the same way.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAttachment } from '../../src/attachment';
import { normalizeRemoteUrl } from '../../src/repo-identity';
import { setResolverIdentity } from '../../src/resolver-identity';
import { candidateTasks, integrationPolicy, pullTask, validRef, type PullArgs } from '../../src/task-pull';
import type { AgentFinding } from '../../src/tools/_findings';
import { installShapeStub } from '../helpers/shape-stub';

const root = mkdtempSync(join(tmpdir(), 'metabob-taskpull-'));
beforeAll(() => setResolverIdentity({ vesselId: 'metabob-mcp-cell1' }));
afterAll(() => {
  setResolverIdentity({ vesselId: undefined });
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => setAttachment(null));

describe('integrationPolicy', () => {
  const conv = (id: string, author: string, body: string) => ({ id, author, content: `repo: r\nrecorded_by: ${author}\n\n${body}` });

  test('the task declares it; else a trusted convention; else the default', () => {
    const p = integrationPolicy('agf_t1', 'push_to: task\nintegrate: review', [conv('cv1', 'coord', 'integrate: push\nconflicts: rebase')], new Set(['coord']));
    expect(p).toMatchObject({ push_to: 'task/agf_t1', integrate: 'review', conflicts: 'rebase' });
    expect(p.source).toEqual({ push_to: 'task', integrate: 'task', conflicts: 'convention cv1 by coord' });
    expect(integrationPolicy('agf_t1', '', [], new Set())).toMatchObject({ push_to: 'main', integrate: 'push', conflicts: 'rebase', source: { push_to: 'default' } });
  });

  test('an untrusted convention and a value outside the allowed set are refused, and say why', () => {
    const p = integrationPolicy('agf_t1', 'push_to: prod', [conv('cv9', 'stranger', 'push_to: task')], new Set(['coord']));
    expect(p.push_to).toBe('main');
    expect(p.rejected).toContain('convention cv9 by stranger: not a trusted author');
    expect(p.rejected).toContain('push_to: prod (task): not an allowed value');
    // A trusted convention's invalid value falls through to the default too.
    expect(integrationPolicy('agf_t1', '', [conv('cv2', 'coord', 'push_to: task/agf_other')], new Set(['coord'])).push_to).toBe('main');
  });
});

describe('candidateTasks', () => {
  const f = (id: string, sev: string, extra: Partial<AgentFinding> = {}): AgentFinding =>
    ({ id, summary: `[${sev}][task] r: ${id}`, content: 'category: task', ...extra });
  test('its own claims first, then unclaimed by severity; others\' claims, closed and pending tasks are skipped', () => {
    const order = candidateTasks([
      f('low', 'LOW'), f('high', 'HIGH'), f('mine', 'LOW', { claim: { by: 'me', until: 0, here: true } }),
      f('theirs', 'CRITICAL', { claim: { by: 'x', until: 0, here: false } }), f('done', 'HIGH', { verdict: 'fixed' }),
      f('pend', 'HIGH', { pending: { here: false } }), { id: 'bug', summary: '[CRITICAL][security] r: bug', content: 'category: security' },
    ]).map(t => t.id);
    expect(order).toEqual(['mine', 'high', 'low']);
  });
});

describe('pullTask', () => {
  /** A bare origin with one commit on main, and its repository identity. */
  function origin(name: string): { url: string; repo: string } {
    const bare = join(root, `${name}.git`);
    const seed = join(root, `${name}-seed`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'stats.ts'), 'export const average = (xs: number[]) => xs.length;\n');
    const g = (...a: string[]) => execFileSync('git', ['-C', seed, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a]);
    g('add', '.');
    g('commit', '-qm', 'seed');
    g('push', '-q', bare, 'main');
    return { url: bare, repo: normalizeRemoteUrl(bare)! };
  }

  async function ledger(repo: string, tasks: Array<{ n: string; sev: string; details?: string; repo?: string; files?: string }>, verdicts: Array<Record<string, unknown>> = [], opts: { writesUnseen?: Array<Record<string, unknown>> } = {}) {
    const rows: Array<Record<string, unknown>> = [
      ...tasks.map(t => ({
        id: `concept:concept_${t.n}`, shape: 'code_finding', summary: `[${t.sev}][task] r: task ${t.n}`, created_at: new Date(Date.now() - 3_600_000).toISOString(),
        content: `repo: ${t.repo ?? repo}\nfiles: ${t.files ?? 'stats.ts'}\nseverity: ${t.sev}\ncategory: task\nfinding_ids: agf_${t.n}\nrecorded_by: coord${t.details ? `\n\n${t.details}` : ''}`,
      })),
      ...verdicts,
    ];
    let n = 0;
    await installShapeStub({
      conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape) } }),
      conceptGraph: (p) => {
        const root = rows.find(r => String(r.id) === `concept:${p.concept_id}`);
        return root ? { body: { content: { root, edges: [] } } } : { status: 404, body: { error: 'Concept not found' } };
      },
      concept_create_write: (p) => {
        n++;
        const id = `v${String(n).padStart(3, '0')}`;
        // writesUnseen: the write lands, but reads never show it (concept-db's read path behind its write).
        (opts.writesUnseen ?? rows).push({ id: `concept:${id}`, shape: p.conceptData.shape, summary: p.conceptData.summary, content: p.conceptData.content, created_at: new Date().toISOString() });
        return { body: { success: true, content: JSON.stringify({ id }) } };
      },
    });
    return rows;
  }

  const args = (url: string, name: string): PullArgs => ({
    origin: url, taskDir: join(root, `${name}-task`), workDir: join(root, `${name}-work`), minutes: 30, trust: [], json: false,
  });

  test('claims the most severe open task, writes /task with its policy, and clones /work', async () => {
    const o = origin('o1');
    const rows = await ledger(o.repo, [{ n: 't1', sev: 'LOW' }, { n: 't2', sev: 'HIGH', details: 'Add median().\npush_to: task\nintegrate: review' }]);
    const a = args(o.url, 'p1');
    const r = await pullTask(a, 'sess1', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(0);
    expect(r.message).toContain('pulled agf_t2');
    const task = JSON.parse(readFileSync(join(a.taskDir, 'task.json'), 'utf8'));
    expect(task).toMatchObject({ task_id: 'agf_t2', concept_id: 'concept_t2', files: ['stats.ts'], repo: o.repo, claim: { by: 'metabob-mcp-cell1' } });
    expect(task.policy).toMatchObject({ push_to: 'task/agf_t2', integrate: 'review', conflicts: 'rebase', source: { push_to: 'task', conflicts: 'default' } });
    expect(readFileSync(join(a.taskDir, 'context.md'), 'utf8')).toContain('Add median().');
    expect(existsSync(join(a.workDir, 'stats.ts'))).toBe(true);
    // The base finding close takes its range from.
    expect(task.base).toBe(execFileSync('git', ['-C', a.workDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    const claims = rows.filter(x => String(x.content).includes('verdict: claimed'));
    expect(claims).toHaveLength(1);
    expect(String(claims[0]!.content)).toContain(`repo: ${o.repo}`);
  });

  test('a vessel origin pulls a task recorded in the super-repo on its files, with the paths mapped', async () => {
    const o = origin('development-vessel');
    await ledger(o.repo, [
      { n: 'sup', sev: 'HIGH', repo: 'github.com/avigopal/substrate', files: 'repos/development-vessel/stats.ts' },
      { n: 'other', sev: 'CRITICAL', repo: 'github.com/avigopal/substrate', files: 'repos/activity-api/src/x.ts' },
    ]);
    const a = args(o.url, 'pdv');
    const r = await pullTask(a, 'sess1', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(0);
    const task = JSON.parse(readFileSync(join(a.taskDir, 'task.json'), 'utf8'));
    expect(task).toMatchObject({ task_id: 'agf_sup', files: ['stats.ts'], repo: o.repo });
  });

  test('skips a task someone else holds and takes the next', async () => {
    const o = origin('o2');
    await ledger(o.repo, [{ n: 'a', sev: 'HIGH' }, { n: 'b', sev: 'LOW' }], [{
      id: 'concept:held', shape: 'finding_verdict', created_at: new Date(Date.now() - 60_000).toISOString(),
      content: 'finding: agf_a\nverdict: claimed\nclaim_minutes: 60\nreviewed_by: metabob-mcp-cell2',
    }]);
    const r = await pullTask(args(o.url, 'p2'), 'sess2', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(0);
    expect(r.message).toContain('pulled agf_b');
  });

  test('when every open task is held by others it exits 4 with the earliest claim end', async () => {
    const o = origin('o4');
    const at = Date.now() - 60_000;
    await ledger(o.repo, [{ n: 'h', sev: 'HIGH' }], [{
      id: 'concept:held4', shape: 'finding_verdict', created_at: new Date(at).toISOString(),
      content: 'finding: agf_h\nverdict: claimed\nclaim_minutes: 10\nreviewed_by: metabob-mcp-cell2',
    }]);
    const r = await pullTask(args(o.url, 'p4'), 'sess4', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(4);
    expect(r.extra?.retry_after).toBe(new Date(at + 10 * 60_000).toISOString());
  });

  test('a claim the reads never show is withdrawn, and the pull says to retry soon', async () => {
    const o = origin('o-unseen');
    const unseen: Array<Record<string, unknown>> = [];
    await ledger(o.repo, [{ n: 'u', sev: 'HIGH' }], [], { writesUnseen: unseen });
    const r = await pullTask(args(o.url, 'p7'), 'sess7', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(4);
    expect(r.message).toContain('unsettled');
    expect(unseen.map(x => /verdict: (\w[\w ]*)/.exec(String(x.content))?.[1])).toEqual(['claimed', 'claim withdrawn']);
    expect(Date.parse(String(r.extra?.retry_after)) - Date.now()).toBeLessThan(31_000);
  });

  test('a bad ref after the claim withdraws the claim, so the task is not blocked', async () => {
    const o = origin('o5');
    const rows = await ledger(o.repo, [{ n: 'r', sev: 'HIGH', details: 'ref: ..bad' }]);
    const a = args(o.url, 'p5');
    const r = await pullTask(a, 'sess5', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(1);
    expect(r.message).toContain('not a branch name git accepts');
    expect(r.message).toContain('The claim on agf_r was withdrawn');
    expect(rows.filter(x => String(x.content).includes('verdict: claim withdrawn'))).toHaveLength(1);
    expect(existsSync(a.workDir)).toBe(false);
  });

  test('a clone failure after the claim withdraws the claim', async () => {
    const o = origin('o6');
    const rows = await ledger(o.repo, [{ n: 'c', sev: 'HIGH', details: 'ref: no-such-branch' }]);
    const r = await pullTask(args(o.url, 'p6'), 'sess6', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(1);
    expect(r.message).toContain('cloning');
    expect(rows.filter(x => String(x.content).includes('verdict: claim withdrawn'))).toHaveLength(1);
  });

  test('task.json records whether the trust list was defaulted', async () => {
    const o = origin('o7');
    await ledger(o.repo, [{ n: 'd', sev: 'HIGH' }]);
    const a = { ...args(o.url, 'p7'), trust: ['coordinator-1'] };
    expect((await pullTask(a, 'sess7', 'metabob-mcp-cell1', [0, 0, 0])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(a.taskDir, 'task.json'), 'utf8')).trust).toEqual({ authors: ['coordinator-1'], defaulted: false });
  });

  test('validRef: git\'s branch-name rules, no leading dash, at most 100 characters', () => {
    expect(validRef('main')).toBe(true);
    expect(validRef('task/agf_x')).toBe(true);
    for (const bad of ['..bad', 'a..b', 'x@{1}', 'a.lock', '-x', '--upload-pack=x', 'a b', 'x'.repeat(101), '']) expect(validRef(bad)).toBe(false);
  });

  test('with no task this cell can take it exits 3 and writes nothing', async () => {
    const o = origin('o3');
    await ledger(o.repo, []);
    const a = args(o.url, 'p3');
    const r = await pullTask(a, 'sess3', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(3);
    expect(existsSync(a.taskDir)).toBe(false);
    expect(existsSync(a.workDir)).toBe(false);
  });
});
