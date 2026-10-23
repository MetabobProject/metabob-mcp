/**
 * get_problems and get_analysis_context lead with one count of open findings
 * across the local store and the cross-agent recall (SPEC §get_problems), so an
 * agent never reads "No problems found in the local store" as "nothing to do"
 * while shared findings sit below it.
 */
import { describe, expect, test } from 'bun:test';
import type { SeedRecord } from '../../src/local-store';
import { openFindingsHeadline, type AgentFinding, type AgentFindingsResult } from '../../src/tools/_findings';

function seed(id: string, concept?: string): SeedRecord {
  return {
    id, workspace_id: 'w', file_path: 'src/a.ts', line_start: 0, line_end: 0, category: 'c',
    severity: 'HIGH', brief: 'b', confidence: 1, refs_json: concept ? JSON.stringify([`concept:${concept}`]) : '[]',
    produced_at: 0, read_at: null, stale: false,
  } as SeedRecord;
}

function finding(id: string, agf: string[], verdict?: AgentFinding['verdict']): AgentFinding {
  return { id, summary: id, content: `files: src/a.ts\nfinding_ids: ${agf.join(', ')}`, ...(verdict ? { verdict } : {}) };
}

const ok = (findings: AgentFinding[]): AgentFindingsResult => ({ status: 'ok', findings });

describe('openFindingsHeadline', () => {
  test('shared findings count when the local store is empty', () => {
    expect(openFindingsHeadline([], ok([finding('concept_1', ['agf_x']), finding('concept_2', ['agf_y'])])))
      .toBe('Open findings: 2 (0 in the local store, 2 recorded by agents on this codebase)');
  });

  test('a finding in both places is counted once, and a multi-file finding is one finding', () => {
    // agf_a1 + agf_a2: one finding over two files, shared as concept_a. agf_b: local only.
    const local = [seed('agf_a1', 'concept_a'), seed('agf_a2', 'concept_a'), seed('agf_b')];
    const recall = ok([finding('concept_a', ['agf_a1', 'agf_a2']), finding('concept_c', ['agf_c'])]);
    expect(openFindingsHeadline(local, recall))
      .toBe('Open findings: 3 (2 in the local store, 2 recorded by agents on this codebase; 1 in both)');
  });

  test('a local seed with no linked concept overlaps through the agf ids the concept carries', () => {
    expect(openFindingsHeadline([seed('agf_q')], ok([finding('concept_q', ['agf_q'])])))
      .toBe('Open findings: 1 (1 in the local store, 1 recorded by agents on this codebase; 1 in both)');
  });

  test('closed shared findings are not open', () => {
    expect(openFindingsHeadline([], ok([finding('concept_1', ['agf_1'], 'fixed'), finding('concept_2', ['agf_2'], 'retracted')])))
      .toBe('Open findings: 0 (0 in the local store, 0 recorded by agents on this codebase)');
  });

  test('a recall that did not run says so instead of counting it as zero', () => {
    expect(openFindingsHeadline([seed('agf_1')], { status: 'refused', findings: [], detail: 'key_rejected: …' }))
      .toBe('Open findings: 1 in the local store; findings recorded by other agents could not be recalled (see below)');
    expect(openFindingsHeadline([], { status: 'skipped', findings: [] }))
      .toBe('Open findings: 0 in the local store; not attached to a substrate, so findings recorded by other agents are not recalled');
  });

  test('an unavailable local store is named, not counted as zero', () => {
    expect(openFindingsHeadline(null, ok([finding('concept_1', ['agf_1'])])))
      .toBe('Open findings: 1 (local store unavailable, 1 recorded by agents on this codebase)');
  });
});
