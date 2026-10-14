/**
 * Every substrate tool's error text carries the named network cause: with the
 * attachment authenticated and each resolve meeting an inspection proxy, every
 * tool in SUBSTRATE_TOOLS answers with `tls_intercepted(<issuer>)` and
 * `TLS_INTERCEPTED` — the one request path names it, and the tools pass it on.
 * CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role, CONFORMANCE §c9-fail-visibly
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { NetError } from '../../src/net';
import { attach, setAttachment } from '../../src/attachment';
import { SUBSTRATE_TOOLS, TOOL_REGISTRY } from '../../src/tools';

const INPUTS: Record<string, Record<string, unknown>> = {
  run_goal: { goal: 'g' },
  run_goal_async: { goal: 'g' },
  goal_status: { dispatch_id: 'd1' },
  goal_reasoning: { dispatch_id: 'd1' },
  provide_feedback: { dispatch_id: 'd1', verdict: 'reached', rationale: 'r' },
  registry_query: { mode: 'shapes' },
  execution_trace: { execution_id: 'e1' },
  resolve_impulse: { shape: 'memoryNote', pointer: {} },
  concept_search: { query: 'q' },
  concept_neighbors: { concept_id: 'c1' },
  concept_usage_stats: { concept_id: 'c1' },
  concept_sequence: { concept_id: 'c1' },
  concept_link: { from_concept_id: 'c1', to_concept_id: 'c2', edge_type: 'related_to' },
  concept_create: { shape: 'note', content: 'x', summary: 's', source_type: 'memo' },
  concept_record_usage: { concept_id: 'c1', outcome: 'success' },
};

describe('every substrate tool reports the named network cause (CONFORMANCE §c8-proxy-and-tls-in-the-vessel-role)', () => {
  afterEach(() => setAttachment(null));

  test('each tool in SUBSTRATE_TOOLS has an input here', () => {
    expect(Object.keys(INPUTS).sort()).toEqual([...SUBSTRATE_TOOLS].sort());
  });

  for (const name of Object.keys(INPUTS)) {
    test(`${name}: an intercepted TLS connection reads as tls_intercepted(<issuer>) with TLS_INTERCEPTED`, async () => {
      // Attached and authenticated, then every resolve meets an inspection proxy.
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.pathname === '/bootstrap') return Response.json({ identity_endpoint: 'http://identity.stub' });
        if (url.pathname === '/health') return Response.json({ status: 'ok' });
        if (url.pathname === '/v1/auth/resolve') return Response.json({ valid: true, org_id: 'org' });
        throw new NetError('tls_intercepted', 'tls_intercepted(Corp Inspection CA)',
          'tls_intercepted(Corp Inspection CA): TLS_INTERCEPTED — the certificate chain for discovery.stub:443 is signed by "Corp Inspection CA", which this process does not trust',
          { url: url.toString(), via: 'http://proxy.corp:3128', issuer: 'Corp Inspection CA', elapsedMs: 1, transient: false });
      }) as typeof fetch;
      const a = attach({ discovery: 'http://discovery.stub', key: 'k', heartbeatMs: 0, log: () => {}, fetchImpl, sleep: async () => {} });
      await a.settled();
      setAttachment(a);
      const tool = TOOL_REGISTRY[name]!;
      process.env.RUN_GOAL_TIMEOUT_MS = '50';
      process.env.RUN_GOAL_POLL_MS = '1';
      let out: string;
      try {
        out = await tool.handler(tool.validateInput(INPUTS[name]), {}, 's', null);
      } catch (err) {
        out = err instanceof Error ? err.message : String(err);
      } finally {
        delete process.env.RUN_GOAL_TIMEOUT_MS;
        delete process.env.RUN_GOAL_POLL_MS;
      }
      expect(out).toContain('tls_intercepted(Corp Inspection CA)');
      expect(out).toContain('TLS_INTERCEPTED');
    });
  }
});
