/**
 * Tasks are listed apart from problems (SPEC §get_problems): a `task` finding is work assigned on the ledger, and
 * an agent checking a file before an edit must not take another agent's task for a problem it should fix.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';
import type { SeedRecord } from '../../src/local-store';
import { setAttachment } from '../../src/attachment';
import { setResolverIdentity } from '../../src/resolver-identity';
import { workspaceRepo } from '../../src/tools/_findings';
import * as GetProblems from '../../src/tools/get-problems';
import * as GetAnalysisContext from '../../src/tools/get-analysis-context';
import { installShapeStub } from '../helpers/shape-stub';
import { cleanupTempStores, makeTempStore } from '../helpers/temp-store';

beforeAll(() => setResolverIdentity({ vesselId: 'metabob-mcp-thiscell' }));
afterAll(() => setResolverIdentity({ vesselId: undefined }));
afterEach(() => {
  cleanupTempStores();
  setAttachment(null);
});

const api = {} as AnalysisAPIClient;

function store() {
  const { store } = makeTempStore('tasks-');
  const base: Omit<SeedRecord, 'id' | 'category' | 'brief' | 'file_path'> = {
    workspace_id: 'default', line_start: 1, line_end: 1, severity: 'MEDIUM', confidence: 1,
    refs_json: '[]', produced_at: Date.now(), read_at: null, stale: false,
  };
  store.upsertSeed({ ...base, id: 'agf_bug1', category: 'correctness', brief: 'sum() drops the last element', file_path: 'src/util.ts' });
  store.upsertSeed({ ...base, id: 'agf_task1', category: 'task', brief: 'add median()', file_path: 'src/stats.ts' });
  return store;
}

async function recall(withClaim = false) {
  const repo = workspaceRepo()!.id;
  const rows = [
    { id: 'concept:cf_task2', shape: 'code_finding', summary: `[LOW][task] x: port stats to bigint`, content: `repo: ${repo}\nfiles: src/big.ts\ncategory: task\nfinding_ids: agf_task2` },
    { id: 'concept:cf_bug2', shape: 'code_finding', summary: `[HIGH][security] x: token logged`, content: `repo: ${repo}\nfiles: src/auth.ts\ncategory: security\nfinding_ids: agf_bug2` },
    ...(withClaim ? [{ id: 'concept:c1', shape: 'finding_verdict', created_at: new Date(Date.now() - 60_000).toISOString(),
      content: 'finding: agf_task2\nverdict: claimed\nclaim_minutes: 60\nreviewed_by: metabob-mcp-other' }] : []),
  ];
  await installShapeStub({ conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape) } }) });
}

test('get_problems lists tasks apart, with their claims, and the headline counts them apart', async () => {
  await recall(true);
  const out = await GetProblems.handle(GetProblems.InputSchema.parse({}), api, 's', store());
  const [beforeTasks, tasks] = out.split('Tasks: work assigned on the ledger, not problems in the code');
  expect(out.split('\n')[0]).toMatch(/^Open findings: 2 \(1 in the local store, 1 recorded by agents on this codebase\); 2 open tasks, listed apart$/);
  expect(beforeTasks).toContain('sum() drops the last element');
  expect(beforeTasks).toContain('token logged');
  expect(beforeTasks).not.toContain('add median()');
  expect(beforeTasks).not.toContain('port stats to bigint');
  expect(tasks).toContain('(2 open: 1 unclaimed, 1 claimed by others)');
  // The next move first: the unclaimed task comes before the one someone else holds.
  expect(tasks.indexOf('add median()')).toBeLessThan(tasks.indexOf('port stats to bigint'));
  expect(tasks).toContain('claim it with claim_finding');
  expect(tasks).toMatch(/port stats to bigint {2}\[claimed by metabob-mcp-other until \S+ \S+Z: someone is working on it\]/);
  expect(tasks).toContain('add median()');
});

test('asked for by category, tasks are the list itself', async () => {
  await recall();
  const out = await GetProblems.handle(GetProblems.InputSchema.parse({ category: ['task'] }), api, 's', store());
  expect(out).not.toContain('Tasks: work assigned on the ledger');
  expect(out).toContain('add median()');
  expect(out).toContain('port stats to bigint');
});

test('get_analysis_context counts and lists problems only', async () => {
  await recall();
  const out = await GetAnalysisContext.handle(GetAnalysisContext.InputSchema.parse({}), api, 's', store());
  expect(out).toContain('1 open (0 critical, 0 high)');
  expect(out).not.toContain('add median()');
  expect(out).toContain('open tasks, listed apart');
});

test('tasks this checkout holds come first, marked as yours', async () => {
  const repo = workspaceRepo()!.id;
  const task = (n: string, title: string) => ({ id: `concept:cf_${n}`, shape: 'code_finding', summary: `[LOW][task] x: ${title}`, content: `repo: ${repo}\nfiles: src/${n}.ts\ncategory: task\nfinding_ids: agf_${n}` });
  const claim = (n: string, by: string) => ({ id: `concept:c_${n}`, shape: 'finding_verdict', created_at: new Date(Date.now() - 60_000).toISOString(), content: `finding: agf_${n}\nverdict: claimed\nclaim_minutes: 60\nreviewed_by: ${by}` });
  const rows = [task('t1', 'theirs'), task('t2', 'free'), task('t3', 'mine'), claim('t1', 'metabob-mcp-other'), claim('t3', 'metabob-mcp-thiscell')];
  await installShapeStub({ conceptSearch: (p) => ({ body: { content: rows.filter(r => r.shape === p.shape) } }) });
  const out = await GetProblems.handle(GetProblems.InputSchema.parse({}), api, 's', null);
  const tasks = out.slice(out.indexOf('Tasks: work assigned'));
  expect(tasks).toContain('(3 open: 1 yours, 1 unclaimed, 1 claimed by others)');
  expect(tasks).toMatch(/• mine {2}\[yours: claimed by this checkout until/);
  expect(tasks.indexOf('• mine')).toBeLessThan(tasks.indexOf('• free'));
  expect(tasks.indexOf('• free')).toBeLessThan(tasks.indexOf('• theirs'));
});
