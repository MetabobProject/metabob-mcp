/**
 * W2 — the ledger across two sessions (skills/metabob/SKILL.md, Phases 0, 3, 4).
 *
 * Two server processes share one substrate and one workspace but not a home
 * directory, so nothing passes between them except through concept-db:
 *   A records a finding;
 *   B recalls it (get_problems, get_analysis_context) and closes it by the
 *     concept id recall hands it — B holds no local seed for it;
 *   A then sees it closed, and no longer offered as open work — in the
 *     recall and in its own local cache, through both orientation calls.
 */

import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { FakeSubstrate } from './harness/fake-substrate';
import { McpServer, cleanupTempDirs, makeWorkspace } from './harness/mcp-client';

// Each server boot is a process spawn; slow CI runners need more than the 5 s default.
setDefaultTimeout(30_000);
const BOOT_TIMEOUT_MS = 30_000;

const SUMMARY = 'token refresh races the session sweep';
const SECOND = 'session sweep logs the raw token';

let fake: FakeSubstrate;
let a: McpServer;
let b: McpServer;
let conceptId: string;
let secondConceptId: string;

beforeAll(async () => {
  fake = await FakeSubstrate.start();
  const workspace = makeWorkspace('ledger-ws', { 'src/auth.ts': 'export function refresh() {}\n' });
  [a, b] = await Promise.all([
    McpServer.start({ workspace, env: { ...fake.env(), SESSION_ID: 'session-a' } }),
    McpServer.start({ workspace, env: { ...fake.env(), SESSION_ID: 'session-b' } }),
  ]);
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()]);
  await fake?.stop();
  cleanupTempDirs();
}, BOOT_TIMEOUT_MS);

/** The part of get_problems output above the cross-agent recall: the local seed cache. */
function localPart(text: string): string {
  const i = text.indexOf('Findings recorded by agents on this codebase');
  return i < 0 ? text : text.slice(0, i);
}

/** The open list of the cross-agent recall, above its closed section. */
function openRecall(text: string): string {
  const start = text.indexOf('Findings recorded by agents on this codebase');
  if (start < 0) return '';
  const rest = text.slice(start);
  const closed = rest.indexOf('Closed findings');
  return closed < 0 ? rest : rest.slice(0, closed);
}

describe('W2 ledger across two sessions', () => {
  test('A records a finding: a local seed and a code_finding concept', async () => {
    const out = await a.text('record_finding', {
      files: ['src/auth.ts'],
      summary: SUMMARY,
      severity: 'HIGH',
      category: 'correctness',
      details: 'owns: src/auth.ts. out of bounds: src/session.ts.',
    });
    expect(out).toMatch(/src\/auth\.ts\s+→\s+agf_/);
    expect(out).toContain('shared org-wide via concept-db');

    const second = await a.text('record_finding', {
      files: ['src/auth.ts'], summary: SECOND, severity: 'MEDIUM', category: 'security',
    });
    expect(second).toContain('shared org-wide via concept-db');

    const findings = fake.state.concepts.filter(c => c.shape === 'code_finding');
    expect(findings).toHaveLength(2);
    expect(findings[0]!.content).toContain('repo: ledger-ws');
    expect(findings[0]!.content).toContain('session: session-a');
    conceptId = findings[0]!.id;
    secondConceptId = findings[1]!.id;
  });

  test('B recalls it through get_problems and get_analysis_context', async () => {
    const problems = await b.text('get_problems');
    // The first line counts both sources: B's empty local store must not read as "none".
    expect(problems.split('\n')[0]).toBe('Open findings: 2 (0 in the local store, 2 recorded by agents on this codebase)');
    expect(localPart(problems)).not.toContain(SUMMARY); // B has no seed of its own
    expect(openRecall(problems)).toContain(SUMMARY);
    expect(openRecall(problems)).toContain(`concept: ${conceptId}`);

    const context = await b.text('get_analysis_context');
    expect(context).toContain('Open findings: 2 (0 in the local store, 2 recorded by agents on this codebase)');
    expect(context).toContain('Review 2 open findings recorded by agents on this codebase');
    expect(openRecall(context)).toContain(SUMMARY);
  });

  test('B closes it by concept id, writing a verdict from the recalled concept', async () => {
    const out = await b.text('mark_complete', { problem_id: conceptId, action: 'endorse' });
    expect(out).toContain('endorsed from the shared record');
    expect(out).toContain('nothing local was retired');

    const verdicts = fake.state.concepts.filter(c => c.shape === 'finding_verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.content).toMatch(/^finding: agf_/m);
    expect(verdicts[0]!.content).toContain('origin: remote');
    expect(verdicts[0]!.content).toContain('session: session-b');
    expect(fake.state.usage).toContainEqual(expect.objectContaining({ conceptId, outcome: 'success' }));
  });

  test('A sees it closed in get_problems, and not offered as open work', async () => {
    const problems = await a.text('get_problems');
    expect(problems).toContain('Closed findings');
    expect(problems).toMatch(new RegExp(`\\[FIXED\\][^\\n]*${SUMMARY}`));
    expect(openRecall(problems)).not.toContain(SUMMARY);
    // A's own seed of the same finding must not keep listing it as open.
    expect(localPart(problems)).not.toContain(SUMMARY);
    // The finding nobody closed stays open, in both places.
    expect(localPart(problems)).toContain(SECOND);
    expect(openRecall(problems)).toContain(SECOND);
    // A's seed and the shared concept are one finding, counted once.
    expect(problems.split('\n')[0]).toBe('Open findings: 1 (1 in the local store, 1 recorded by agents on this codebase; 1 in both)');
  });

  test('a finding B retracts leaves A\'s get_analysis_context too', async () => {
    const out = await b.text('mark_complete', { problem_id: secondConceptId, action: 'discard' });
    expect(out).toContain('discarded from the shared record');

    const context = await a.text('get_analysis_context');
    expect(context).toContain('closed findings suppressed');
    expect(openRecall(context)).not.toContain(SECOND);
    expect(localPart(context)).not.toContain(SECOND);
    expect(context).toContain('Open findings: 0 (0 in the local store, 0 recorded by agents on this codebase)');
    expect(context).toMatch(/local store: 0 open/);
  });
});
