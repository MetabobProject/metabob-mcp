#!/usr/bin/env bun
/**
 * Runs the Claude Code session scenarios and reports them.
 *
 *   bun tests/claude-sessions/run.ts [--target fake|lab] [--proxy none|http|connect|basic|mitm]
 *                                    [--only S1,S2] [--model sonnet] [--lab-lifecycle fresh|reuse|keep]
 *
 * Against the lab, the run drives lab/lab.sh first (lab/README.md, Trials): `reuse` checks the running
 * lab and brings it up only when the check fails; `fresh` destroys it and brings it up from scratch,
 * and stops it (`down`, volumes kept) after the scenarios; `keep` is `reuse` that says so. A lifecycle
 * failure fails the run before any scenario starts.
 *
 * Prints, per scenario, each assertion's outcome, the tool-call sequence of each session, cost and
 * time; writes the full report (every tool call with its input and result, evidence ids) to
 * .metabob-test/claude-sessions/<timestamp>.json. Each session is a real, billed Claude Code run.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, callLines, cleanupTemp, labEnv, startTarget, type ProxyMode, type TargetKind } from './harness';
import { SCENARIOS, type Ctx } from './scenarios';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const targetKind = arg('target', 'fake') as TargetKind;
const proxyMode = arg('proxy', 'none') as ProxyMode;
const model = arg('model', 'sonnet');
const only = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
if (!['fake', 'lab'].includes(targetKind)) throw new Error(`--target ${targetKind}: fake or lab`);
if (!['none', 'http', 'connect', 'basic', 'mitm'].includes(proxyMode)) throw new Error(`--proxy ${proxyMode}: none, http, connect, basic or mitm`);
type Lifecycle = 'fresh' | 'reuse' | 'keep';
const lifecycle = arg('lab-lifecycle', 'reuse') as Lifecycle;
if (!['fresh', 'reuse', 'keep'].includes(lifecycle)) throw new Error(`--lab-lifecycle ${lifecycle}: fresh, reuse or keep`);

const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const outDir = join(REPO_ROOT, '.metabob-test', 'claude-sessions');
const rawDir = join(outDir, stamp);
mkdirSync(rawDir, { recursive: true });

// ── Lab lifecycle (lab/lab.sh), before the target reads the lab's key ──────────
interface LabStep { step: string; pass: boolean; durationMs: number; tail?: string }
const labSteps: LabStep[] = [];
const LAB_SH = join(REPO_ROOT, 'lab', 'lab.sh');
const labDefaults = labEnv();
const ownLab = !process.env.LAB_DISCOVERY && !process.env.LAB_KEY_FILE;

function labStep(step: string, extra: string[] = []): boolean {
  const started = Date.now();
  console.log(`lab: ${step} ...`);
  const r = spawnSync('bash', [LAB_SH, step, ...extra, '--quiet'], { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const pass = r.status === 0;
  const s: LabStep = { step, pass, durationMs: Date.now() - started, ...(pass ? {} : { tail: out.split('\n').slice(-20).join('\n') }) };
  labSteps.push(s);
  console.log(`lab: ${step} ${pass ? 'PASS' : 'FAIL'} (${(s.durationMs / 1000).toFixed(0)} s)`);
  for (const line of out.split('\n').filter(Boolean).slice(pass ? -3 : -20)) console.log(`     ${line}`);
  return pass;
}

function runLifecycle(): string | null {
  if (lifecycle === 'fresh') {
    for (const step of ['destroy', 'up', 'check']) if (!labStep(step)) return step;
    return null;
  }
  // Reuse proves the attachment only: the full check dispatches one identical goal, and
  // goal-host's spend-rate policy caps identical goals per hour, so running it before every
  // trial exhausts the cap. `fresh` (and `lab.sh check`) still prove a reach.
  if (labStep('check', ['--attach-only'])) return null;
  console.log('lab: the check failed; bringing the lab up and checking again');
  if (!labStep('up')) return 'up';
  return labStep('check', ['--attach-only']) ? null : 'check';
}

function writeReport(report: any): string {
  const path = join(outDir, `${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

const labLifecycle = targetKind === 'lab' && ownLab;
if (targetKind === 'lab' && !ownLab) {
  console.log(`lab: LAB_DISCOVERY / LAB_KEY_FILE set; the lab at ${labDefaults.discovery} is not lab/lab.sh's, so --lab-lifecycle does not apply`);
}
if (labLifecycle) {
  const failedStep = runLifecycle();
  if (failedStep) {
    const path = writeReport({
      startedAt: new Date().toISOString(), target: `lab at ${labDefaults.discovery}`, model,
      lab: { lifecycle, steps: labSteps, failedStep }, scenarios: [], totalCostUsd: 0,
    });
    console.log(`\nLAB LIFECYCLE FAILED at \`lab.sh ${failedStep}\` (--lab-lifecycle ${lifecycle}): no scenario ran. This is the lab, not a scenario; see lab/lab.log. Report ${path}`);
    process.exit(1);
  }
}

const target = await startTarget(targetKind, proxyMode);
console.log(`target: ${target.describe}`);
for (const n of target.notes) console.log(`  note: ${n}`);

const selected = SCENARIOS.filter((s) => {
  if (only.length) return only.includes(s.id);
  if (s.proxyOnly && proxyMode === 'none') return false;
  if (s.liveOnly && targetKind !== 'lab') return false;
  return true;
});

const report: any = {
  startedAt: new Date().toISOString(), target: target.describe, notes: target.notes, model,
  ...(labLifecycle ? { lab: { lifecycle, steps: labSteps } } : {}),
  scenarios: [],
};
let totalCost = 0;
const mark = (p: boolean | null) => (p === null ? ' -- ' : p ? 'PASS' : 'FAIL');

try {
  for (const scenario of selected) {
    if (scenario.liveOnly && targetKind !== 'lab') {
      console.log(`\n== ${scenario.id} ${scenario.title}: live-only, skipped on the fake`);
      report.scenarios.push({ id: scenario.id, title: scenario.title, skipped: 'live-only' });
      continue;
    }
    if (scenario.proxyOnly && proxyMode === 'none') {
      console.log(`\n== ${scenario.id} ${scenario.title}: needs --proxy, skipped`);
      report.scenarios.push({ id: scenario.id, title: scenario.title, skipped: 'needs --proxy' });
      continue;
    }
    target.fake?.resetState();
    const ctx: Ctx = { target, rawDir, model, evidence: {}, log: (l) => console.log(`  ${l}`) };
    const started = Date.now();
    console.log(`\n== ${scenario.id} ${scenario.title}`);
    let result;
    try {
      result = await scenario.run(ctx);
    } catch (err) {
      result = { checks: [{ name: 'scenario ran', pass: false, detail: (err as Error).stack ?? String(err) }], sessions: [] };
    }
    const cost = result.sessions.reduce((s, t) => s + t.costUsd, 0);
    totalCost += cost;
    const failed = result.checks.filter((c) => c.pass === false).length;
    for (const c of result.checks) console.log(`  [${mark(c.pass)}] ${c.name}${c.detail && c.pass !== true ? ` — ${c.detail}` : ''}`);
    for (const t of result.sessions) {
      console.log(`  -- ${t.label}: ${t.calls.length} tool calls, $${t.costUsd.toFixed(3)}, ${(t.durationMs / 1000).toFixed(0)} s, ${t.numTurns ?? '?'} turns, ${t.resultSubtype}`);
      for (const line of callLines(t, 110)) console.log(`     ${line}`);
      for (const line of t.outOfScope) console.log(`     (refused, outside the brief) ${line.slice(0, 120)}`);
    }
    if (Object.keys(ctx.evidence).length) console.log(`  evidence: ${JSON.stringify(ctx.evidence)}`);
    console.log(`  => ${failed ? `FAIL (${failed})` : 'PASS'}  $${cost.toFixed(3)}  ${((Date.now() - started) / 1000).toFixed(0)} s`);
    report.scenarios.push({
      id: scenario.id,
      title: scenario.title,
      pass: failed === 0,
      costUsd: cost,
      durationMs: Date.now() - started,
      checks: result.checks,
      evidence: ctx.evidence,
      sessions: result.sessions.map((t) => ({
        label: t.label, init: t.init && { ...t.init, tools: undefined }, costUsd: t.costUsd, durationMs: t.durationMs,
        numTurns: t.numTurns, resultSubtype: t.resultSubtype, skillLoads: t.skillLoads, finalText: t.finalText,
        harnessErrors: t.harnessErrors, outOfScope: t.outOfScope, permissionDenials: t.permissionDenials, rawPath: t.rawPath,
        transcript: callLines(t, 400),
        calls: t.calls,
      })),
    });
  }
} finally {
  report.totalCostUsd = totalCost;
  report.proxyRequests = target.proxy?.requests.length ?? null;
  await target.stop();
  cleanupTemp();
  // `fresh` stops the lab it built; `down` keeps the volumes, so the next `up` is fast.
  let teardown = 'none (the lab keeps running)';
  if (labLifecycle && lifecycle === 'fresh') {
    teardown = labStep('down') ? 'down (volumes kept)' : 'down FAILED';
    report.lab.teardownFailed = !labSteps[labSteps.length - 1]!.pass;
  }
  if (labLifecycle) report.lab.teardown = teardown;
  const path = writeReport(report);
  const passed = report.scenarios.filter((s: any) => s.pass).length;
  const ran = report.scenarios.filter((s: any) => s.pass !== undefined).length;
  const labLine = labLifecycle
    ? `; lab ${lifecycle}: ${labSteps.map((s) => `${s.step} ${s.pass ? 'ok' : 'FAIL'} ${(s.durationMs / 1000).toFixed(0)}s`).join(', ')}; teardown ${teardown}`
    : '';
  console.log(`\n${passed}/${ran} scenarios passed; total $${totalCost.toFixed(3)}${labLine}; report ${path}`);
}
process.exit(report.scenarios.every((s: any) => s.pass !== false) && !report.lab?.teardownFailed ? 0 : 1);
