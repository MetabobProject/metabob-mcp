/**
 * Scenarios: each is a small prompt (or two) plus assertions on the transcript — the tool calls, their
 * inputs and results — and, against the fake, on what reached the substrate. Never on prose.
 *
 * A check is `pass: null` when it cannot be made against the current target (a fake-state check on
 * the lab, a lab-only check on the fake); the report prints it as not checked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FOREIGN_KEY, SERVER_NAME, buildPluginDir, check, idsIn, labEnv, makeWorkspace, metabobCalls, runSession, skipped,
  tempDir, type Check, type Target, type Transcript,
} from './harness';

export interface Ctx {
  target: Target;
  rawDir: string;
  model: string;
  /** Saved for the report: dispatch ids, finding ids, trace ids, proxy evidence. */
  evidence: Record<string, unknown>;
  log: (line: string) => void;
}

export interface ScenarioResult {
  checks: Check[];
  sessions: Transcript[];
}

export interface Scenario {
  id: string;
  title: string;
  /** Meaningful only against a live lab: skipped on the fake. */
  liveOnly?: boolean;
  /** Runs only on the proxy leg. */
  proxyOnly?: boolean;
  run(ctx: Ctx): Promise<ScenarioResult>;
}

// ── Fixture workspace ────────────────────────────────────────────────────────

const PAGINATION = `/** Number of pages needed to show \`total\` items, \`size\` per page. */
export function pageCount(total: number, size: number): number {
  if (size <= 0) throw new Error('size must be positive');
  return Math.floor(total / size);
}
`;

const RETRY = `/** Calls \`fn\` up to \`attempts\` times, returning the first success. */
export async function retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown;
  for (let i = 1; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
`;

const MONEY = `/** Converts a dollar amount to integer cents. */
export function toCents(dollars: number): number {
  return Math.floor(dollars * 100);
}
`;

const FILES = {
  'package.json': JSON.stringify({ name: 'shop-utils', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  'README.md': '# shop-utils\n\nSmall helpers for the shop frontend.\n',
  'src/index.ts': "export * from './pagination';\nexport * from './retry';\nexport * from './money';\n",
  'src/pagination.ts': PAGINATION,
  'src/retry.ts': RETRY,
  'src/money.ts': MONEY,
};

/**
 * Each run names its workspaces uniquely: the ledger keys recall on the repository name, and a lab's
 * concept-db keeps what earlier runs recorded, which must never read as this run's open work.
 */
const RUN = Math.random().toString(36).slice(2, 7);
let wsSeq = 0;
const workspace = (name: string) => makeWorkspace(`${name}-${RUN}${++wsSeq}`, FILES);

const CORE_TOOLS = [
  'get_analysis_context', 'get_problems', 'record_finding', 'mark_complete', 'init_workspace',
  'analyze_impact', 'run_goal_async', 'goal_status', 'goal_reasoning', 'provide_feedback', 'registry_query',
  'execution_trace', 'concept_search',
];

// ── Shared checks ────────────────────────────────────────────────────────────

function sessionChecks(t: Transcript): Check[] {
  const checks: Check[] = [
    check(`${t.label}: session ended normally`, t.resultSubtype === 'success' || t.resultSubtype === 'error_max_turns',
      `result ${t.resultSubtype}, exit ${t.exitCode}${t.stderrTail ? `, stderr: ${t.stderrTail.slice(-200)}` : ''}`),
    check(`${t.label}: no refusal of a pre-approved tool (harness)`, t.harnessErrors.length === 0 && t.permissionDenials.length === 0,
      [...t.harnessErrors, ...t.permissionDenials.map((d) => JSON.stringify(d))].join(' | ') || undefined),
  ];
  return checks;
}

function initChecks(t: Transcript): Check[] {
  const init = t.init;
  if (!init) return [check(`${t.label}: init event`, false, 'no system/init event')];
  const plugin = init.plugins.find((p) => p.name === 'metabob');
  const server = init.mcpServers.find((s) => s.name === SERVER_NAME);
  const missing = CORE_TOOLS.filter((x) => !init.metabobTools.includes(x));
  return [
    check('init: the plugin under test is loaded (inline, not the installed one)', plugin?.source === 'metabob@inline',
      JSON.stringify(plugin)),
    check('init: plugin MCP server connected', server?.status === 'connected', JSON.stringify(server)),
    check('init: its tools are offered', missing.length === 0 && init.metabobTools.length > 0,
      `${init.metabobTools.length} tools${missing.length ? `; missing ${missing.join(', ')}` : ''}`),
    check('init: the plugin skill is listed', init.skills.includes('metabob:metabob'),
      init.skills.filter((s) => s.includes('metabob')).join(', ')),
  ];
}

const isFake = (ctx: Ctx) => ctx.target.fake !== null;

function substrate(ctx: Ctx, name: string, fn: () => [boolean, string?]): Check {
  if (!ctx.target.fake) return skipped(name, 'fake-state check; not made against the lab');
  const [pass, detail] = fn();
  return check(name, pass, detail);
}

/** The requests the fake recorded since `mark`. */
function since(ctx: Ctx, mark: number) {
  return ctx.target.fake ? ctx.target.fake.requests.slice(mark) : [];
}

function mark(ctx: Ctx): number {
  return ctx.target.fake?.requests.length ?? 0;
}

function plugin(ctx: Ctx, label: string, key?: string): string {
  return buildPluginDir(ctx.target, { home: tempDir(`home-${label}`), ...(key ? { key } : {}) });
}

// ── S1 ───────────────────────────────────────────────────────────────────────

async function s1(ctx: Ctx, label = 'S1'): Promise<ScenarioResult> {
  const ws = workspace('orient-ws');
  const m = mark(ctx);
  const t = await runSession({
    label,
    prompt: "Orient yourself in this repository's shared work ledger, then say in two sentences what is known to be open here.",
    workspace: ws,
    pluginDir: plugin(ctx, label),
    maxTurns: 8,
    model: ctx.model,
    rawDir: ctx.rawDir,
  });
  // stream-json and the debug log do not carry the system prompt, so the instructions are observed by
  // asking a second, tool-less session to quote them: the fragment is fixed text, not a judgement.
  const quote = await runSession({
    label: `${label}-instructions`,
    prompt: 'Do not call any tool. Quote verbatim the first sentence of the MCP server instructions you were given for the metabob server, or answer NONE if you have none.',
    workspace: ws,
    pluginDir: plugin(ctx, `${label}-instructions`),
    maxTurns: 1,
    model: ctx.model,
    rawDir: ctx.rawDir,
  });
  const skill = t.skillLoads.find((s) => /metabob/.test(s.skill));
  const oriented = metabobCalls(t).filter((c) => ['get_analysis_context', 'get_problems'].includes(c.tool));
  const instructionsFragment = 'a shared work ledger and code-structure tools'; // the METABOB_TOOLS=all instructions
  const reqs = since(ctx, m);
  const checks: Check[] = [
    ...sessionChecks(t),
    ...initChecks(t),
    check('skill: the agent loads the metabob skill', !!skill && !skill.isError,
      skill ? `Skill ${JSON.stringify(skill.skill)}${skill.isError ? ` errored: ${skill.result?.slice(0, 200)}` : ''}` : `skill loads: ${JSON.stringify(t.skillLoads.map((s) => s.skill))}`),
    check('instructions: the agent orients with get_analysis_context / get_problems', oriented.length > 0,
      oriented.map((c) => c.tool).join(', ') || 'neither called'),
    check('orientation calls succeed', oriented.length > 0 && oriented.every((c) => !c.isError),
      oriented.filter((c) => c.isError).map((c) => c.result?.slice(0, 160)).join(' | ') || undefined),
    check('instructions: the initialize instructions are in the agent\'s context (quoted back)',
      quote.finalText.includes(instructionsFragment) && quote.calls.length === 0, quote.finalText.slice(0, 200)),
    substrate(ctx, 'substrate: key proven at identity and the ledger recalled from concept-db', () => {
      const auth = reqs.filter((r) => r.operation === 'authResolve');
      const recall = reqs.filter((r) => r.operation === 'conceptSearch');
      return [auth.some((r) => r.status === 200) && recall.length > 0, `authResolve ${auth.map((r) => r.status).join(',')}; conceptSearch ×${recall.length}`];
    }),
  ];
  ctx.evidence[`${label}.skill`] = skill?.skill ?? null;
  return { checks, sessions: [t, quote] };
}

// ── S2 ───────────────────────────────────────────────────────────────────────

async function s2(ctx: Ctx, label = 'S2'): Promise<ScenarioResult> {
  const ws = workspace('ledger-ws');
  const m = mark(ctx);
  const rec = await runSession({
    label: `${label}-record`,
    prompt: 'Review src/pagination.ts for bugs. Do not edit any file. Record each bug you find in the shared work ledger so that another agent can fix it later, then stop.',
    workspace: ws,
    pluginDir: plugin(ctx, `${label}-record`),
    maxTurns: 10,
    model: ctx.model,
    rawDir: ctx.rawDir,
  });
  const recorded = metabobCalls(rec, 'record_finding');
  const onFile = recorded.filter((c) => JSON.stringify(c.input?.files ?? []).includes('pagination.ts'));
  const recIds = new Set(onFile.flatMap((c) => idsIn(c.result ?? '')));

  const fix = await runSession({
    label: `${label}-fix`,
    prompt: "Pick up the open work in this repository's shared work ledger: fix what it lists, and close each item in the ledger once it is fixed.",
    workspace: ws,
    pluginDir: plugin(ctx, `${label}-fix`),
    maxTurns: 16,
    model: ctx.model,
    extraTools: ['Edit'],
    rawDir: ctx.rawDir,
  });
  const recall = metabobCalls(fix).filter((c) => ['get_problems', 'get_analysis_context'].includes(c.tool));
  const recallIds = new Set(recall.flatMap((c) => idsIn(c.result ?? '')));
  const closes = metabobCalls(fix, 'mark_complete');
  const endorse = closes.filter((c) => c.input?.action === 'endorse' && !c.isError);
  const closesRecorded = endorse.filter((c) => recIds.has(String(c.input?.problem_id)) || recallIds.has(String(c.input?.problem_id)));
  const edited = fix.calls.filter((c) => c.tool === 'Edit' && String(c.input?.file_path ?? '').endsWith('pagination.ts'));
  const after = readFileSync(join(ws, 'src/pagination.ts'), 'utf-8');
  const reqs = since(ctx, m);
  ctx.evidence[`${label}.findingIds`] = [...recIds];
  ctx.evidence[`${label}.closed`] = closes.map((c) => `${c.input?.problem_id} ${c.input?.action}`);

  const checks: Check[] = [
    ...sessionChecks(rec),
    ...sessionChecks(fix),
    check('record: record_finding names src/pagination.ts', onFile.length > 0,
      recorded.map((c) => JSON.stringify(c.input?.files)).join(' ') || 'record_finding not called'),
    check('record: the finding is shared org-wide (tool output)', onFile.some((c) => /shared org-wide via concept-db/.test(c.result ?? '')),
      onFile.map((c) => c.result?.replace(/\s+/g, ' ').slice(0, 200)).join(' | ')),
    check('record: no file edited by the recorder', !rec.calls.some((c) => ['Edit', 'Write'].includes(c.tool))),
    check('fix: the second session recalls the ledger', recall.length > 0, recall.map((c) => c.tool).join(', ')),
    check('fix: it fixes src/pagination.ts', edited.length > 0 && /Math\.ceil|% size|\+ size - 1/.test(after),
      after.split('\n').find((l) => l.includes('return')) ?? ''),
    check('fix: it closes the recorded finding (mark_complete endorse)', closesRecorded.length > 0,
      closes.map((c) => `${c.input?.problem_id}:${c.input?.action} → ${c.result?.replace(/\s+/g, ' ').slice(0, 120)}`).join(' | ') || 'mark_complete not called'),
    substrate(ctx, 'substrate: a code_finding concept for src/pagination.ts', () => {
      const f = ctx.target.fake!.state.concepts.filter((c) => c.shape === 'code_finding' && c.content.includes('pagination.ts'));
      return [f.length > 0, f.map((c) => c.id).join(', ')];
    }),
    substrate(ctx, 'substrate: a finding_verdict endorsing it, and a success usage on the finding', () => {
      const s = ctx.target.fake!.state;
      const verdicts = s.concepts.filter((c) => c.shape === 'finding_verdict');
      const findingIds = s.concepts.filter((c) => c.shape === 'code_finding').map((c) => c.id);
      const success = s.usage.filter((u) => u.outcome === 'success' && findingIds.includes(u.conceptId));
      return [verdicts.length > 0 && success.length > 0,
        `${verdicts.length} verdict(s): ${verdicts.map((v) => v.content.split('\n').slice(0, 3).join('; ')).join(' | ')}; success usage ×${success.length}`];
    }),
    substrate(ctx, 'substrate: writes went through discovery (forwarded)', () => {
      const writes = reqs.filter((r) => r.operation === 'conceptCreate');
      return [writes.length > 0 && writes.every((r) => r.forwarded), `conceptCreate ×${writes.length}, forwarded ×${writes.filter((r) => r.forwarded).length}`];
    }),
  ];
  return { checks, sessions: [rec, fix] };
}

// ── S3 ───────────────────────────────────────────────────────────────────────

async function s3(ctx: Ctx): Promise<ScenarioResult> {
  const ws = workspace('coord-ws');
  let startB: () => void = () => {};
  const bGate = new Promise<void>((r) => (startB = r));
  const gateTimer = setTimeout(() => startB(), 90_000);
  let bStartedAtMs: number | null = null;
  const aStarted = Date.now();

  const aRun = runSession({
    label: 'S3-A',
    prompt: 'Review src/retry.ts and src/money.ts for bugs. Do not edit any file. Record each bug in the shared work ledger, one finding per file, so other agents can pick them up; then stop.',
    workspace: ws,
    pluginDir: plugin(ctx, 'S3-A'),
    maxTurns: 12,
    model: ctx.model,
    rawDir: ctx.rawDir,
    onEvent: (_e, t) => {
      if (metabobCalls(t, 'record_finding').some((c) => c.result !== null)) startB();
    },
  });
  await bGate;
  clearTimeout(gateTimer);
  bStartedAtMs = Date.now() - aStarted;
  const bRun = runSession({
    label: 'S3-B',
    prompt: "Other agents are working in this repository right now and coordinate through its shared work ledger. Pick up open work from the ledger, fix it, and close in the ledger what you fix.",
    workspace: ws,
    pluginDir: plugin(ctx, 'S3-B'),
    maxTurns: 20,
    model: ctx.model,
    extraTools: ['Edit'],
    rawDir: ctx.rawDir,
  });
  const [a, b] = await Promise.all([aRun, bRun]);

  const aRecords = metabobCalls(a, 'record_finding');
  const aIds = new Set(aRecords.flatMap((c) => idsIn(c.result ?? '')));
  const aFiles = new Set(aRecords.flatMap((c) => (c.input?.files ?? []) as string[]).map((f) => f.replace(/^\.\//, '')));
  const bInputs = metabobCalls(b).map((c) => JSON.stringify(c.input));
  // B holds A's findings by the ids recall handed it (concept_* for another home).
  const bRecall = metabobCalls(b).filter((c) => ['get_problems', 'get_analysis_context'].includes(c.tool));
  const recalledFromA = new Set(bRecall.flatMap((c) => idsIn(c.result ?? '')));
  const bCloses = metabobCalls(b, 'mark_complete');
  const bClosedIds = bCloses.map((c) => String(c.input?.problem_id));
  const referencesA = bClosedIds.filter((id) => aIds.has(id) || recalledFromA.has(id));
  const bRecords = metabobCalls(b, 'record_finding');
  const dupFiles = bRecords.flatMap((c) => (c.input?.files ?? []) as string[]).map((f) => f.replace(/^\.\//, '')).filter((f) => aFiles.has(f));
  const aCloses = metabobCalls(a, 'mark_complete');
  const repeated = bClosedIds.filter((id, i) => bClosedIds.indexOf(id) !== i);
  const overlapMs = Math.min(a.durationMs, bStartedAtMs + b.durationMs) - bStartedAtMs;
  ctx.evidence['S3.aIds'] = [...aIds];
  ctx.evidence['S3.bClosed'] = bCloses.map((c) => `${c.input?.problem_id} ${c.input?.action} → ${(c.result ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
  ctx.evidence['S3.bStartedAfterMs'] = bStartedAtMs;

  const checks: Check[] = [
    ...sessionChecks(a),
    ...sessionChecks(b),
    check('A records findings on both files', ['src/retry.ts', 'src/money.ts'].every((f) => [...aFiles].some((x) => x.endsWith(f))),
      [...aFiles].join(', ')),
    check('the sessions overlap in time', overlapMs > 0, `B started ${bStartedAtMs} ms after A; overlap ${overlapMs} ms`),
    check("B's tool calls reference A's finding ids", referencesA.length > 0 || bInputs.some((s) => [...aIds].some((id) => s.includes(id))),
      `A: ${[...aIds].join(', ')}; B closed: ${bClosedIds.join(', ') || 'none'}`),
    check('B closes at least one of them', bCloses.some((c) => !c.isError && referencesA.includes(String(c.input?.problem_id)))),
    check('no duplicated work: B records nothing on A\'s files, A closes nothing, B closes each id once',
      dupFiles.length === 0 && aCloses.length === 0 && repeated.length === 0,
      `B records on A's files: ${dupFiles.join(', ') || 'none'}; A closes: ${aCloses.length}; repeated closes: ${repeated.join(', ') || 'none'}`),
    substrate(ctx, 'substrate: verdicts written for the findings B closed', () => {
      const v = ctx.target.fake!.state.concepts.filter((c) => c.shape === 'finding_verdict');
      return [v.length >= Math.max(1, referencesA.length), `${v.length} verdict(s)`];
    }),
  ];
  return { checks, sessions: [a, b] };
}

// ── S4 ───────────────────────────────────────────────────────────────────────

const GOAL = 'edit repos/demo-vessel/src/greet.ts: make greet() return "hello, world"';

async function s4(ctx: Ctx): Promise<ScenarioResult> {
  const fake = ctx.target.fake;
  if (fake) {
    // An operator's key; the walk answers an ask at once, with one move and an answer citing it.
    fake.ownerKind = 'operator';
    fake.onRecordWrite = (row) => {
      if (row.shape !== 'world_changed') return;
      const s = fake.state;
      s.openRoots.add(row.id);
      const at = () => ({ seq: s.rows.length + 1, t: new Date().toISOString(), writer: 'walk-fake' });
      s.rows.push({ ...at(), id: `row_sel_${row.id}`, shape: 'selection', role: 'walk', input_refs: [row.id], root: row.id, a: 'call/feature_compose', cands: [{ id: 'call/feature_compose', kind: 'call' }], posts: [{ alpha: 4, beta: 1, from: 'cell' }] });
      s.rows.push({ ...at(), id: `row_ans_${row.id}`, shape: 'answer', role: 'described', input_refs: [row.id], selection_ref: `row_sel_${row.id}`, text: 'landed commit 1a2b3c4: greet() returns "hello, world"; typecheck passed' });
    };
  }
  const m = mark(ctx);
  const t = await runSession({
    label: 'S4',
    prompt: `Dispatch this goal on the substrate asynchronously: "${GOAL}". Track it until it has an answer, decide whether the answer does what was asked and why, and leave your note on it as feedback.`,
    workspace: workspace('goal-ws'),
    pluginDir: plugin(ctx, 'S4'),
    maxTurns: ctx.target.fake ? 14 : 10,
    model: ctx.model,
    rawDir: ctx.rawDir,
  });
  if (fake) {
    fake.ownerKind = undefined;
    fake.onRecordWrite = undefined;
  }
  const dispatch = metabobCalls(t, 'run_goal_async')[0];
  const dispatchId = /dispatchId:\s*(\S+)/.exec(dispatch?.result ?? '')?.[1] ?? null;
  const polls = metabobCalls(t, 'goal_status').filter((c) => c.input?.dispatch_id === dispatchId);
  const feedback = metabobCalls(t, 'provide_feedback').filter((c) => c.input?.dispatch_id === dispatchId);
  const reqs = since(ctx, m);
  ctx.evidence['S4.dispatchId'] = dispatchId;
  ctx.evidence['S4.feedback'] = feedback.map((c) => ({ verdict: c.input?.verdict, result: c.result?.slice(0, 200) }));

  const lastPoll = polls.at(-1)?.result ?? '';
  const checks: Check[] = [
    ...sessionChecks(t),
    check('one dispatch: no retry', metabobCalls(t, 'run_goal_async').length + metabobCalls(t, 'run_goal').length <= 1,
      `run_goal_async ×${metabobCalls(t, 'run_goal_async').length}, run_goal ×${metabobCalls(t, 'run_goal').length}`),
    ...(isFake(ctx)
      ? [
        check('run_goal_async returns a dispatch id', !!dispatchId, dispatch?.result?.slice(0, 160) ?? 'not called'),
        check('goal_status read until the ask has an answer', /answer row_ans_/.test(lastPoll), `${polls.length} read(s); last: ${lastPoll.split('\n').slice(0, 3).join(' / ')}`),
        check("provide_feedback on that ask, without error, says it is not a verdict", feedback.length > 0 && feedback.every((c) => !c.isError && /not a verdict/.test(c.result ?? '')),
          feedback.map((c) => `${c.input?.verdict}: ${c.result?.replace(/\s+/g, ' ').slice(0, 140)}`).join(' | ') || 'not called'),
        check('the agent notes the answer reached', feedback.some((c) => c.input?.verdict === 'reached'), feedback.map((c) => c.input?.verdict).join(', ')),
      ]
      : [
        // The lab's key is not an operator's: every goal tool waits on the cockpit's own sign-in.
        check('lab: the goal tools say they wait on the cockpit\'s own sign-in',
          !!dispatch && /waiting on the cockpit's own sign-in/.test(dispatch.result ?? ''), dispatch?.result?.slice(0, 200) ?? 'not called'),
      ]),
    substrate(ctx, 'substrate: the ask is an operator\'s world_changed row naming the goal', () => {
      const ask = ctx.target.fake!.state.rows.find((r) => r.id === dispatchId);
      return [ask?.shape === 'world_changed' && ask.what === GOAL && ask.role === 'operator', JSON.stringify(ask && { shape: ask.shape, role: ask.role })];
    }),
    substrate(ctx, "substrate: one operator's outcome row on the answer, and no other write", () => {
      const notes = ctx.target.fake!.state.rows.filter((r) => r.shape === 'outcome');
      const writes = reqs.filter((r) => r.operation === 'recordWrite');
      return [notes.length === 1 && notes[0]!.role === 'operator' && notes[0]!.input_refs[0] === `row_ans_${dispatchId}` && writes.length === 2,
        `${JSON.stringify(notes.map((n) => ({ r: n.r, role: n.role, refs: n.input_refs })))}; record_write ×${writes.length}`];
    }),
  ];
  return { checks, sessions: [t] };
}

// ── S5 ───────────────────────────────────────────────────────────────────────

async function s5(ctx: Ctx): Promise<ScenarioResult> {
  const m = mark(ctx);
  const t = await runSession({
    label: 'S5',
    prompt: "Orient yourself in this repository's shared work ledger and look up the org's design memory (the concept graph) for this repository. Then use the local analysis tools to tell me which files a change to src/pagination.ts would affect.",
    workspace: workspace('foreign-ws'),
    pluginDir: plugin(ctx, 'S5', FOREIGN_KEY),
    maxTurns: 10,
    model: ctx.model,
    rawDir: ctx.rawDir,
  });
  const calls = metabobCalls(t);
  const rejected = calls.filter((c) => /key_rejected/.test(c.result ?? ''));
  const firstReject = rejected[0]?.index ?? Infinity;
  // A loop: the same tool with the same input called again after the agent saw key_rejected.
  const after = calls.filter((c) => c.index > firstReject && /key_rejected/.test(c.result ?? ''));
  const keys = after.map((c) => `${c.tool}${JSON.stringify(c.input)}`);
  const retried = keys.filter((k, i) => keys.indexOf(k) !== i || rejected.some((r) => r.index === firstReject && `${r.tool}${JSON.stringify(r.input)}` === k));
  const local = calls.filter((c) => ['init_workspace', 'analyze_impact', 'predict_cochanges', 'search_codebase'].includes(c.tool));
  const reqs = since(ctx, m);
  ctx.evidence['S5.rejectedLines'] = [...new Set(rejected.map((c) => (c.result ?? '').split('\n').find((l) => l.includes('key_rejected'))?.slice(0, 200)))];

  const checks: Check[] = [
    ...sessionChecks(t),
    check('a substrate tool answers key_rejected', rejected.length > 0, rejected.map((c) => c.tool).join(', ') || 'none'),
    check('a pure substrate tool answers with the one line, starting key_rejected:',
      rejected.some((c) => c.isError && /^key_rejected:/.test((c.result ?? '').trim()) && (c.result ?? '').trim().split('\n').length === 1),
      rejected.filter((c) => /^key_rejected:/.test((c.result ?? '').trim())).map((c) => c.tool).join(', ') || 'only mixed tools answered'),
    check('the cause is one line naming key_rejected', rejected.every((c) => (c.result ?? '').split('\n').some((l) => /key_rejected:/.test(l))),
      String(ctx.evidence['S5.rejectedLines'])),
    check('no retry loop after key_rejected', retried.length === 0 && rejected.length <= 4, `${rejected.length} key_rejected answers; repeats: ${retried.join(' ; ') || 'none'}`),
    check('local tools still work', local.some((c) => c.tool !== 'init_workspace' && !c.isError) && local.every((c) => !/key_rejected/.test(c.result ?? '')),
      local.map((c) => `${c.tool}${c.isError ? ' [ERROR]' : ''}`).join(', ') || 'no local tool called'),
    check('the key never appears in a tool result', calls.every((c) => !(c.result ?? '').includes(FOREIGN_KEY))),
    substrate(ctx, 'substrate: identity refused the key; nothing was written', () => {
      const auth = reqs.filter((r) => r.operation === 'authResolve');
      const writes = reqs.filter((r) => ['conceptCreate', 'conceptUsage', 'recordWrite'].includes(r.operation ?? ''));
      return [auth.length > 0 && auth.every((r) => r.status === 401) && writes.length === 0, `authResolve ${auth.map((r) => r.status).join(',')}; writes ×${writes.length}`];
    }),
  ];
  return { checks, sessions: [t] };
}

// ── S6 ───────────────────────────────────────────────────────────────────────

async function s6(ctx: Ctx): Promise<ScenarioResult> {
  const proxy = ctx.target.proxy!;
  const before = proxy.requests.length;
  const one = await s1(ctx, 'S6-S1');
  const two = await s2(ctx, 'S6-S2');
  const reqs = proxy.requests.slice(before);
  // CONNECT names host:port; an absolute-form request names a URL, shown by its origin.
  const targets = [...new Set(reqs.map((r) => `${r.method} ${/^https?:\/\//.test(r.target) ? new URL(r.target).origin : r.target}`))];
  ctx.evidence['S6.proxyRequests'] = reqs.length;
  ctx.evidence['S6.proxyTargets'] = targets;
  const viaIdentity = reqs.some((r) => r.target.includes('identity.invalid'));
  const viaAnchor = reqs.some((r) => r.target.includes('spoke.invalid'));
  const fakeReqs = ctx.target.fake?.requests.length ?? 0;
  const checks: Check[] = [
    ...one.checks.map((c) => ({ ...c, name: `S1 via proxy — ${c.name}` })),
    ...two.checks.map((c) => ({ ...c, name: `S2 via proxy — ${c.name}` })),
    check('proxy: the anchor (spoke.invalid) was reached through the proxy', viaAnchor, targets.join(', ')),
    ctx.target.kind === 'fake' || ctx.target.notes.every((n) => !n.startsWith('LAB_IDENTITY unset'))
      ? check('proxy: identity (identity.invalid) was reached through the proxy', viaIdentity)
      : skipped('proxy: identity through the proxy', 'LAB_IDENTITY unset'),
    ctx.target.proxyMode === 'basic'
      ? check('proxy: every request carried Basic credentials', reqs.every((r) => /^Basic /.test(r.proxyAuthorization ?? '')))
      : skipped('proxy: Basic credentials', `proxy mode ${ctx.target.proxyMode}`),
    substrate(ctx, 'substrate: the fake was reached (only the proxy can reach .invalid names)', () => [fakeReqs > 0, `${fakeReqs} requests`]),
  ];
  return { checks, sessions: [...one.sessions, ...two.sessions] };
}

// ── NET (live only) ──────────────────────────────────────────────────────────

async function net(ctx: Ctx): Promise<ScenarioResult> {
  const t = await runSession({
    label: 'NET',
    prompt: 'Using the metabob tools only: list the vessels on the substrate network that produce concept and execution-trace shapes, search the concept graph for any concepts, and read one execution trace if you can find an execution id.',
    workspace: workspace('net-ws'),
    pluginDir: plugin(ctx, 'NET'),
    maxTurns: 12,
    model: ctx.model,
    rawDir: ctx.rawDir,
  });
  const reg = metabobCalls(t, 'registry_query');
  const regText = reg.map((c) => c.result ?? '').join('\n');
  const nodes = labEnv().nodes.split(',').map((s) => s.trim()).filter(Boolean);
  const concepts = metabobCalls(t, 'concept_search');
  const traces = metabobCalls(t, 'execution_trace');
  ctx.evidence['NET.registry'] = regText.slice(0, 2000);
  ctx.evidence['NET.traceIds'] = traces.map((c) => c.input?.execution_id);
  return {
    checks: [
      ...sessionChecks(t),
      check('registry_query answers through the spoke', reg.length > 0 && reg.every((c) => !c.isError), reg.map((c) => JSON.stringify(c.input)).join(' ')),
      nodes.length
        ? check(`registry shows producers on the other node(s) through the spoke (${nodes.join(', ')})`, nodes.every((n) => regText.includes(n)),
          nodes.map((n) => `${n}: ${regText.includes(n) ? 'yes' : 'no'}`).join(', '))
        : skipped('registry shows producers from every node', 'LAB_NODES unset'),
      check('concept_search succeeds via the spoke', concepts.length > 0 && concepts.every((c) => !c.isError),
        concepts.map((c) => (c.result ?? '').slice(0, 100)).join(' | ')),
      check('execution_trace succeeds (or reports a missing trace) via the spoke', traces.length > 0 && traces.every((c) => !c.isError || /not found|404/.test(c.result ?? '')),
        traces.map((c) => `${c.input?.execution_id}: ${(c.result ?? '').slice(0, 100)}`).join(' | ') || 'not called'),
    ],
    sessions: [t],
  };
}

export const SCENARIOS: Scenario[] = [
  { id: 'S1', title: 'skill & instructions', run: (ctx) => s1(ctx) },
  { id: 'S2', title: 'feedback & ledger: record, then another session fixes and closes', run: (ctx) => s2(ctx) },
  { id: 'S3', title: 'coordination: two concurrent sessions in one workspace', run: s3 },
  { id: 'S4', title: 'goals & feedback: run_goal_async → goal_status → provide_feedback', run: s4 },
  { id: 'S5', title: 'attachment failure honesty: a foreign key', run: s5 },
  { id: 'S6', title: 'proxy leg: S1 + S2 through the corporate proxy', proxyOnly: true, run: s6 },
  { id: 'NET', title: 'capability from the network: producers on every node, via the spoke', liveOnly: true, run: net },
];
