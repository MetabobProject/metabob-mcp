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
import { candidateTasks, integrationPolicy, pullTask, taskKind, validRef, type PullArgs } from '../../src/task-pull';
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

  test('a convention trusted by its stamped key, by name or id', () => {
    const stamped = { id: 'cv9', author: 'ops-key', writer: ['ops-key', 'key_O1'], content: 'repo: r\nrecorded_by: someone\n\npush_to: task' };
    expect(integrationPolicy('agf_t1', '', [stamped], new Set(['ops-key'])).push_to).toBe('task/agf_t1');
    expect(integrationPolicy('agf_t1', '', [stamped], new Set(['key_O1'])).push_to).toBe('task/agf_t1');
    // The declared author is not the stamped one, and the stamp decides.
    expect(integrationPolicy('agf_t1', '', [stamped], new Set(['someone'])).push_to).toBe('main');
  });

  test('a proposed convention sets nothing until a trusted key endorses it; a rejection or a ruling ends it', () => {
    const base = { id: 'cv7', author: 'agent-key', writer: ['agent-key'], status: 'proposed', content: 'repo: r\nstatus: proposed\n\npush_to: task' };
    const trusted = new Set(['person-key']);
    const policy = (c: Record<string, unknown>) => integrationPolicy('agf_t1', '', [{ ...base, ...c }], trusted);
    expect(policy({}).push_to).toBe('main');
    expect(policy({}).rejected[0]).toContain('proposed, not endorsed by a trusted key');
    // Endorsed by an untrusted key: still a suggestion.
    expect(policy({ endorsedBy: [['agent-key']] }).push_to).toBe('main');
    expect(policy({ endorsedBy: [['person-key']] }).push_to).toBe('task/agf_t1');
    expect(policy({ endorsedBy: [['person-key']], rejectedBy: [['person-key']] }).rejected[0]).toContain('rejected');
    // A convention in effect by its author, retired by a trusted ruling; an untrusted ruling changes nothing.
    const inEffect = { id: 'cv8', author: 'person-key', writer: ['person-key'], content: 'repo: r\n\npush_to: task' };
    expect(integrationPolicy('agf_t1', '', [{ ...inEffect, retiredBy: [['person-key']] }], trusted).rejected[0]).toContain('retired or overruled by a ruling');
    expect(integrationPolicy('agf_t1', '', [{ ...inEffect, retiredBy: [['someone']] }], trusted).push_to).toBe('task/agf_t1');
  });

  test('a task may tighten the convention, never loosen it: pasted text cannot bypass review', () => {
    const review = conv('cv3', 'coord', 'push_to: task\nintegrate: review');
    const p = integrationPolicy('agf_t1', 'Steps to reproduce:\npush_to: main\nintegrate: push', [review], new Set(['coord']));
    expect(p).toMatchObject({ push_to: 'task/agf_t1', integrate: 'review' });
    expect(p.source).toMatchObject({ push_to: 'convention cv3 by coord', integrate: 'convention cv3 by coord' });
    expect(p.rejected).toContain('push_to: main (task): loosens task/agf_t1 (convention cv3 by coord); a task may only tighten it');
    expect(p.rejected).toContain('integrate: push (task): loosens review (convention cv3 by coord); a task may only tighten it');
    // Against the defaults, a task may still ask for its own branch and review.
    expect(integrationPolicy('agf_t1', 'push_to: task\nintegrate: review', [], new Set())).toMatchObject({ push_to: 'task/agf_t1', integrate: 'review', source: { push_to: 'task', integrate: 'task' } });
  });

  test('a trusted convention, else the default; a task tightens either', () => {
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

describe('task kinds', () => {
  const t = (id: string, content: string, extra: Partial<AgentFinding> = {}): AgentFinding =>
    ({ id, summary: `[HIGH][task] r: ${id}`, content, ...extra });
  test('the kind is the first Kind: line of the leading key lines; a pasted one further down is not; none is change', () => {
    expect(taskKind(t('a', 'category: task\n\nGoal: review it\nKind: Review\nOwns: x'))).toBe('review');
    expect(taskKind(t('b', 'category: task\nkind: manage'))).toBe('manage');
    expect(taskKind(t('c', 'category: task\n\nGoal: fix it\n\nissue body:\nKind: review'))).toBe('change');
    expect(taskKind(t('d', 'category: task'))).toBe('change');
  });
  test('with kinds, only tasks of those kinds are candidates, including one this identity holds', () => {
    const tasks = [
      t('rev', 'category: task\n\nKind: review'), t('chg', 'category: task\n\nKind: change'),
      t('mine-rev', 'category: task\n\nKind: review', { claim: { by: 'me', until: 0, here: true } }), t('plain', 'category: task'),
    ];
    expect(candidateTasks(tasks, ['change']).map(x => x.id)).toEqual(['chg', 'plain']);
    expect(candidateTasks(tasks, ['review']).map(x => x.id)).toEqual(['mine-rev', 'rev']);
    expect(candidateTasks(tasks).map(x => x.id)).toEqual(['mine-rev', 'rev', 'chg', 'plain']);
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

  async function ledger(repo: string, tasks: Array<{ n: string; sev: string; details?: string; repo?: string; files?: string }>, verdicts: Array<Record<string, unknown>> = [], opts: { writesUnseen?: Array<Record<string, unknown>>; failShapes?: string[] } = {}) {
    const rows: Array<Record<string, unknown>> = [
      ...tasks.map(t => ({
        id: `concept:concept_${t.n}`, shape: 'code_finding', summary: `[${t.sev}][task] r: task ${t.n}`, created_at: new Date(Date.now() - 3_600_000).toISOString(),
        content: `repo: ${t.repo ?? repo}\nfiles: ${t.files ?? 'stats.ts'}\nseverity: ${t.sev}\ncategory: task\nfinding_ids: agf_${t.n}\nrecorded_by: coord${t.details ? `\n\n${t.details}` : ''}`,
      })),
      ...verdicts,
    ];
    let n = 0;
    await installShapeStub({
      conceptSearch: (p) => (opts.failShapes?.includes(String(p.shape))
        ? { status: 503, body: { error: 'concept-db is restarting' } }
        : { body: { content: rows.filter(r => r.shape === p.shape) } }),
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
    origin: url, taskDir: join(root, `${name}-task`), workDir: join(root, `${name}-work`), minutes: 30, trust: [], kinds: [], json: false,
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

  test('a convention retired by a trusted ruling sets nothing; an endorsed proposal does', async () => {
    const o = origin('o-conv');
    const at = new Date(Date.now() - 600_000).toISOString();
    const conv = (id: string, body: string, extra = '') => ({ id: `concept:${id}`, shape: 'project_convention', created_at: at,
      written_by: 'coord-key', written_by_key: 'key_C1', content: `kind: policy\nrepo: ${o.repo}\n${extra}recorded_by: coord\n\n${body}` });
    await ledger(o.repo, [{ n: 'c1', sev: 'HIGH' }], [
      conv('pc_old', 'integrate: review'),
      conv('pc_new', 'push_to: task', 'status: proposed\n'),
      { id: 'concept:rul1', shape: 'ruling', created_at: at, written_by: 'person-key', written_by_key: 'key_P1',
        content: `kind: ruling\nrepo: ${o.repo}\nsupersedes: pc_old\noutcome: retired\nrecorded_by: dashboard:p` },
      { id: 'concept:end1', shape: 'finding_verdict', created_at: at, written_by: 'person-key', written_by_key: 'key_P1',
        content: `concept: pc_new\nverdict: endorsed\nrepo: ${o.repo}\nreviewed_by: dashboard:p\norigin: dashboard` },
    ]);
    const a = { ...args(o.url, 'pconv'), trust: ['key_C1', 'key_P1'] };
    const r = await pullTask(a, 'sess1', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(0);
    const task = JSON.parse(readFileSync(join(a.taskDir, 'task.json'), 'utf8'));
    // The retired one's integrate: review is gone; the endorsed proposal's push_to: task holds.
    expect(task.policy).toMatchObject({ push_to: 'task/agf_c1', integrate: 'push', source: { push_to: 'convention pc_new by coord-key', integrate: 'default' } });
  });

  test('with the conventions or the rulings unread, task pull withdraws its claim and exits 1, writing no task', async () => {
    for (const shape of ['project_convention', 'ruling']) {
      const o = origin(`o-unread-${shape}`);
      const at = new Date(Date.now() - 600_000).toISOString();
      const rows = await ledger(o.repo, [{ n: 'u1', sev: 'HIGH' }], [
        { id: 'concept:pc_u', shape: 'project_convention', created_at: at, content: `kind: policy\nrepo: ${o.repo}\nrecorded_by: coord\n\nintegrate: review` },
      ], { failShapes: [shape] });
      const a = args(o.url, `punread-${shape}`);
      const r = await pullTask(a, 'sess1', 'metabob-mcp-cell1', [0, 0, 0]);
      expect(r.code).toBe(1);
      expect(r.message).toContain(shape === 'ruling' ? 'the rulings could not be read' : 'the conventions could not be read');
      expect(r.message).toContain('was withdrawn');
      expect(existsSync(join(a.taskDir, 'task.json'))).toBe(false);
      expect(rows.some(x => String(x.content).includes('verdict: claim withdrawn'))).toBe(true);
    }
  });

  test('a page after the first that cannot be read fails the conventions too', async () => {
    const o = origin('o-partial');
    const at = new Date(Date.now() - 600_000).toISOString();
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `concept:pc_${i}`, shape: 'project_convention', created_at: at, content: `kind: policy\nrepo: elsewhere\n\nrule ${i}` }));
    const rows = await ledger(o.repo, [{ n: 'p1', sev: 'HIGH' }], many);
    // The ledger's stub answers every page alike; make the second page of conventions fail.
    await installShapeStub({
      conceptSearch: (p) => (p.shape === 'project_convention' && Number(p.offset ?? 0) > 0
        ? { status: 503, body: { error: 'concept-db is restarting' } }
        : { body: { content: rows.filter(r => r.shape === p.shape) } }),
      conceptGraph: (p) => {
        const root = rows.find(r => String(r.id) === `concept:${p.concept_id}`);
        return root ? { body: { content: { root, edges: [] } } } : { status: 404, body: { error: 'Concept not found' } };
      },
      concept_create_write: (p) => {
        const id = `w${rows.length}`;
        rows.push({ id: `concept:${id}`, shape: p.conceptData.shape, summary: p.conceptData.summary, content: p.conceptData.content, created_at: new Date().toISOString() });
        return { body: { success: true, content: JSON.stringify({ id }) } };
      },
    });
    const a = args(o.url, 'ppartial');
    const r = await pullTask(a, 'sess1', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(1);
    expect(r.message).toContain('the conventions could not all be read');
    expect(existsSync(join(a.taskDir, 'task.json'))).toBe(false);
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

  test('with kinds, open tasks only of other kinds exit 3, and held tasks of these kinds exit 4', async () => {
    const o = origin('o-kinds');
    const at = Date.now() - 60_000;
    await ledger(o.repo, [{ n: 'rv', sev: 'HIGH', details: 'Goal: review\nKind: review' }, { n: 'ch', sev: 'LOW', details: 'Goal: fix\nKind: change' }], [{
      id: 'concept:heldk', shape: 'finding_verdict', created_at: new Date(at).toISOString(),
      content: 'finding: agf_ch\nverdict: claimed\nclaim_minutes: 10\nreviewed_by: metabob-mcp-cell2',
    }]);
    // Only a held change task and a free review task: a change cell waits (4), a deploy cell has nothing (3).
    expect((await pullTask({ ...args(o.url, 'pk1'), kinds: ['change'] }, 'sk1', 'metabob-mcp-cell1', [0, 0, 0])).code).toBe(4);
    expect((await pullTask({ ...args(o.url, 'pk2'), kinds: ['deploy'] }, 'sk2', 'metabob-mcp-cell1', [0, 0, 0])).code).toBe(3);
    const r = await pullTask({ ...args(o.url, 'pk3'), kinds: ['review'] }, 'sk3', 'metabob-mcp-cell1', [0, 0, 0]);
    expect(r.code).toBe(0);
    expect(r.message).toContain('pulled agf_rv');
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
