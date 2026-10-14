/**
 * The concept tools' writes and stats through the one ingress
 * (src/tools/_concept-db.ts): each tool's pointer, as concept-db's resolver reads
 * it, and its answer mapped back to the same output. Writes are one attempt.
 * SPEC §concept-graph-tools, CONFORMANCE §c11-attachment-model
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setAttachment } from '../../src/attachment';
import { handle as conceptCreate } from '../../src/tools/concept-create';
import { handle as conceptLink } from '../../src/tools/concept-link';
import { handle as conceptRecordUsage } from '../../src/tools/concept-record-usage';
import { handle as conceptUsageStats } from '../../src/tools/concept-usage-stats';
import { handle as conceptSequence } from '../../src/tools/concept-sequence';
import { installShapeStub } from '../helpers/shape-stub';
import type { AnalysisAPIClient } from '../../src/api-client';

const apiClient = {} as AnalysisAPIClient;
const written = (row: Record<string, unknown>) => ({ body: { success: true, content: JSON.stringify(row) } });

afterEach(() => setAttachment(null));

describe('concept_create', () => {
  test('writes concept_create_write { conceptData } once and renders the created row', async () => {
    const stub = await installShapeStub({
      concept_create_write: (p) => written({ id: 'concept:c_new1', ...p.conceptData, budget: 2000, priority: 0.5, created_at: '2026-10-13T00:00:00Z' }),
    });
    const out = await conceptCreate(
      { content: 'a lock, not a queue', shape: 'design_decision', source_type: 'memo', summary: 'lock over queue' },
      apiClient,
    );
    expect(stub.calls('concept_create_write')).toEqual([{
      type: 'concept_create_write',
      conceptData: { content: 'a lock, not a queue', shape: 'design_decision', source_type: 'memo', pointer: { type: 'design_decision' }, summary: 'lock over queue' },
    }]);
    expect(out).toContain('  id:          c_new1');
    expect(out).toContain('  summary:     lock over queue');
    expect(out).toContain('  budget:      2000');
    expect(out).toContain('  priority:    0.50');
    expect(out).toContain('  created_at:  2026-10-13T00:00:00Z');
  });

  test("concept-db's 400 is reported, and a write is never retried", async () => {
    const stub = await installShapeStub({
      concept_create_write: () => ({ status: 502, body: { error: 'forward_failed', shape: 'concept_create_write', detail: 'The operation timed out.' } }),
    });
    const out = await conceptCreate({ content: 'x', shape: 's', source_type: 'memo' }, apiClient);
    expect(out).toMatch(/^concept_create: producer_timeout\(concept_create_write, \d+ms\)/);
    expect(stub.calls('concept_create_write')).toHaveLength(1);
  });
});

describe('concept_link', () => {
  test('writes conceptLink_write { linkData } and renders the edge', async () => {
    const stub = await installShapeStub({
      conceptLink_write: () => written({ id: 'concept_edge:edge_1', created: true, new_weight: 0.7 }),
    });
    const out = await conceptLink(
      { from_concept_id: 'c_a', to_concept_id: 'c_b', edge_type: 'related_to', description: 'why', weight: 0.7 },
      apiClient,
    );
    expect(stub.calls('conceptLink_write')).toEqual([{
      type: 'conceptLink_write',
      linkData: { from_concept_id: 'c_a', to_concept_id: 'c_b', edge_type: 'related_to', description: 'why', weight: 0.7 },
    }]);
    expect(out).toStartWith('Edge created in ');
    expect(out).toContain('  id:          edge_1');
    expect(out).toContain('  edge_type:   related_to');
    expect(out).toContain('  weight:      0.70');
    expect(out).toContain('  description: why');
  });

  test('an existing edge is updated by EMA, and the reply says so', async () => {
    await installShapeStub({
      conceptLink_write: () => written({ id: 'edge_1', created: false, previous_weight: 0.5, new_weight: 0.6 }),
    });
    const out = await conceptLink({ from_concept_id: 'c_a', to_concept_id: 'c_b', edge_type: 'related_to' }, apiClient);
    expect(out).toStartWith('Edge exists; weight updated in ');
    expect(out).toContain('  weight:      0.60');
    expect(out).toContain('  previous:    0.50');
  });
});

describe('concept_record_usage', () => {
  test('writes conceptUsage_write { usageData } with the plain concept id', async () => {
    const stub = await installShapeStub({ conceptUsage_write: () => written({ id: 'usage_9', outcome: 'success' }) });
    const out = await conceptRecordUsage(
      { concept_id: 'concept:⟨concept_X⟩', outcome: 'success', trace_id: 'mcp:t1', activity_id: 'a1' },
      apiClient,
    );
    expect(stub.calls('conceptUsage_write')).toEqual([{
      type: 'conceptUsage_write',
      usageData: { concept_id: 'concept_X', trace_id: 'mcp:t1', outcome: 'success', activity_id: 'a1' },
    }]);
    expect(out).toContain('Recorded success usage for concept concept_X');
    expect(out).toContain('  usage row: usage_9');
  });

  test("concept-db's refusal is reported", async () => {
    await installShapeStub({
      conceptUsage_write: () => ({ status: 400, body: { success: false, error: 'concept not found: concept_nope — usage row refused' } }),
    });
    expect(await conceptRecordUsage({ concept_id: 'concept_nope', outcome: 'neutral' }, apiClient)).toBe(
      'concept_record_usage: conceptUsage_write answered 400: concept not found: concept_nope — usage row refused',
    );
  });
});

describe('concept_usage_stats', () => {
  test('the aggregate is conceptUsageStats; the rows are the one direct read, from the endpoint discovery names', async () => {
    const history = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/concepts/c_1/usage' && url.searchParams.get('limit') === '3') {
          return Response.json({ usage: [{ outcome: 'success', recorded_at: '2026-10-13T00:00:00Z', trace_id: 'mcp:t1' }] });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const stub = await installShapeStub({
        conceptUsageStats: () => ({ body: { content: { total_uses: 4, success_rate: 0.75, failure_rate: 0.25, neutral_rate: 0 } } }),
        vesselCapability: (p) => ({
          body: { content: { shape: p.shape, found: true, vessels: [{ vesselId: 'concept-db-local', endpoint: `http://127.0.0.1:${history.port}` }] } },
        }),
      }, { discovery: 'http://127.0.0.1:1' }); // a loopback discovery: its loopback rows are taken as given
      const out = await conceptUsageStats({ concept_id: 'c_1', include_history: true, history_limit: 3 }, apiClient);
      expect(stub.calls('conceptUsageStats')).toEqual([{ type: 'conceptUsageStats', concept_id: 'c_1' }]);
      expect(stub.calls('vesselCapability')).toEqual([{ type: 'vesselCapability', shape: 'conceptUsageStats' }]);
      expect(out).toContain('  total_uses:   4');
      expect(out).toContain('  success_rate: 0.75');
      expect(out).toContain('Recent usage (1):');
      expect(out).toContain('       trace_id: mcp:t1');
    } finally {
      history.stop(true);
    }
  });

  test("a remote discovery's loopback row is taken onto discovery's host", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return Response.json({ usage: [] });
    }) as typeof fetch;
    try {
      await installShapeStub({
        conceptUsageStats: () => ({ body: { content: { total_uses: 0 } } }),
        vesselCapability: (p) => ({ body: { content: { shape: p.shape, found: true, vessels: [{ endpoint: 'http://127.0.0.1:8260', public_endpoint: 'http://127.0.0.1:18260' }] } } }),
      }, { discovery: 'http://hub.example:18100' });
      await conceptUsageStats({ concept_id: 'c_1', include_history: true, history_limit: 2 }, apiClient);
      expect(seen).toEqual(['http://hub.example:18260/concepts/c_1/usage?limit=2']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('without history the stats still render', async () => {
    await installShapeStub({
      conceptUsageStats: () => ({ body: { content: { total_uses: 0, success_rate: 0, failure_rate: 0 } } }),
    });
    const out = await conceptUsageStats({ concept_id: 'c_1', include_history: true, history_limit: 10 }, apiClient);
    expect(out).toContain('  total_uses:   0');
    expect(out).toContain('No recent usage rows.');
  });
});

describe('concept_sequence', () => {
  test('reads conceptSequence { concept_id, direction, limit }', async () => {
    const stub = await installShapeStub({
      conceptSequence: () => ({ body: { content: [{ concept_id: 'concept:c_next', weight: 0.8, times_traversed: 3 }] } }),
    });
    const out = await conceptSequence({ concept_id: 'c_1', direction: 'next', limit: 5 }, apiClient);
    expect(stub.calls('conceptSequence')).toEqual([{ type: 'conceptSequence', concept_id: 'c_1', direction: 'next', limit: 5 }]);
    expect(out).toContain('1 sequence successor of c_1');
    expect(out).toContain('1. c_next');
    expect(out).toContain('   weight=0.80  traversed=3');
  });
});
