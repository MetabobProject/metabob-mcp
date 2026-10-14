#!/usr/bin/env bun
/**
 * Runs the Claude Code session scenarios and reports them.
 *
 *   bun tests/claude-sessions/run.ts [--target fake|lab] [--proxy none|http|connect|basic|mitm]
 *                                    [--only S1,S2] [--model sonnet]
 *
 * Prints, per scenario, each assertion's outcome, the tool-call sequence of each session, cost and
 * time; writes the full report (every tool call with its input and result, evidence ids) to
 * .metabob-test/claude-sessions/<timestamp>.json. Each session is a real, billed Claude Code run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, callLines, cleanupTemp, startTarget, type ProxyMode, type TargetKind } from './harness';
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

const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const outDir = join(REPO_ROOT, '.metabob-test', 'claude-sessions');
const rawDir = join(outDir, stamp);
mkdirSync(rawDir, { recursive: true });

const target = await startTarget(targetKind, proxyMode);
console.log(`target: ${target.describe}`);
for (const n of target.notes) console.log(`  note: ${n}`);

const selected = SCENARIOS.filter((s) => {
  if (only.length) return only.includes(s.id);
  if (s.proxyOnly && proxyMode === 'none') return false;
  if (s.liveOnly && targetKind !== 'lab') return false;
  return true;
});

const report: any = { startedAt: new Date().toISOString(), target: target.describe, notes: target.notes, model, scenarios: [] };
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
  const path = join(outDir, `${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  const passed = report.scenarios.filter((s: any) => s.pass).length;
  const ran = report.scenarios.filter((s: any) => s.pass !== undefined).length;
  console.log(`\n${passed}/${ran} scenarios passed; total $${totalCost.toFixed(3)}; report ${path}`);
  await target.stop();
  cleanupTemp();
}
process.exit(report.scenarios.every((s: any) => s.pass !== false) ? 0 : 1);
