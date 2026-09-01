/**
 * concept_record_usage — the direct write into concept-db's relevance model.
 *
 * The other concept_* tools read the graph; the findings plane creates
 * concepts. This tool is the missing edge: it lets an MCP-side agent
 * ATTRIBUTE an outcome to a concept it used, feeding concept-db's usage
 * chokepoint (`POST /concepts/:id/usage`). concept-db folds the outcome into
 * the Beta-Binomial posterior mean `(times_succeeded + 1) / (times_loaded + 2)`:
 *
 *   - success  → a real credit; raises the concept's relevance
 *   - failure  → grows the load denominator with no credit; lowers relevance
 *   - neutral  → a load event (denominator only); mild deflation toward 0.5
 *
 * Until now MCP influenced relevance only indirectly (passive loads on read,
 * and cross-vessel goal executions). This makes the agent a first-class,
 * deliberate contributor — the same interface concept-db's own execution
 * observer uses when a task completes.
 *
 * Auth: vessel mode only. Talks directly to concept-db over the discovered
 * `conceptGraph` endpoint (or explicit CONCEPT_DB_URL), authenticated with the
 * customer's METABOB_API_KEY (identity-vessel resolves it to a tenant JWT).
 */

import { z } from 'zod';
import { plainConceptId } from './_concept-content.js';
import type { AnalysisAPIClient } from '../api-client.js';
import { resolveServiceEndpointByShape } from '../discovery.js';
import { makeUsageTraceId } from './_findings.js';

export const ConceptRecordUsageTool = {
  name: 'concept_record_usage',
  description:
    "Record an outcome for a concept you used, feeding concept-db's relevance model directly. concept-db computes relevance as a Bayesian success rate (times_succeeded+1)/(times_loaded+2): success raises it, failure/neutral grow the load count without credit. Use this to credit a concept whose guidance led to a good result (success), penalize one that misled you (failure), or just register that you loaded it (neutral). This is the deliberate, first-class way an agent teaches the graph what is actually useful — complements the passive load signal that fires automatically on concept_search.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      concept_id: {
        type: 'string',
        description: 'Concept id to attribute the outcome to (with or without the "concept:" prefix). From concept_search / record_finding / get_problems.',
      },
      outcome: {
        type: 'string',
        enum: ['success', 'failure', 'neutral'],
        description: 'success = the concept helped and the task went well; failure = it misled or was wrong; neutral = merely loaded, no verdict.',
      },
      trace_id: {
        type: 'string',
        description: 'Optional execution/trace id to attribute the usage to. A real id is generated when omitted (template {{...}} placeholders are rejected by concept-db).',
      },
      activity_id: {
        type: 'string',
        description: 'Optional activity id if this usage happened inside a known activity execution.',
      },
      task_id: {
        type: 'string',
        description: 'Optional task id within the activity execution.',
      },
    },
    required: ['concept_id', 'outcome'],
  },
};

export const InputSchema = z.object({
  concept_id: z.string().min(1),
  outcome: z.enum(['success', 'failure', 'neutral']),
  trace_id: z.string().min(1).optional(),
  activity_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
});

export type ConceptRecordUsageInput = z.infer<typeof InputSchema>;

interface UsageResponse {
  id?: string;
  outcome?: string;
  error?: string;
}

export async function handle(
  input: ConceptRecordUsageInput,
  apiClient: AnalysisAPIClient,
): Promise<string> {
  if (!apiClient.hasDiscovery() && !process.env.CONCEPT_DB_URL) {
    return [
      'concept_record_usage requires discovery or an explicit CONCEPT_DB_URL.',
      'Configure DISCOVERY_ENDPOINT to point at discovery-vessel,',
      'or set CONCEPT_DB_URL directly.',
    ].join(' ');
  }

  const start = Date.now();
  const apiKey = process.env.METABOB_API_KEY;
  const conceptDbUrl = await resolveServiceEndpointByShape({
    explicitUrl: process.env.CONCEPT_DB_URL,
    discoveryEndpoint: apiClient.getDiscoveryEndpoint(),
    shape: 'conceptGraph',
    apiKey,
  });
  if (!conceptDbUrl) {
    return 'concept_record_usage could not find concept-db via discovery. Set CONCEPT_DB_URL explicitly or register concept-db with discovery.';
  }

  // Same normalisation as fetchConceptById and mark_complete: concept-db hands
  // back ids wrapped in ⟨⟩, and an unstripped id resolves to nothing while the
  // call still reports success.
  const conceptId = plainConceptId(input.concept_id);
  const traceId = input.trace_id ?? makeUsageTraceId();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

  const body: Record<string, unknown> = { trace_id: traceId, outcome: input.outcome };
  if (input.activity_id) body.activity_id = input.activity_id;
  if (input.task_id) body.task_id = input.task_id;

  const url = `${conceptDbUrl}/concepts/${encodeURIComponent(conceptId)}/usage`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `concept_record_usage failed to reach ${conceptDbUrl}: ${msg}`;
  }

  const duration = Date.now() - start;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return `concept_record_usage: ${res.status} ${text.slice(0, 200)}`;
  }

  const payload = (await res.json().catch(() => ({}))) as UsageResponse;
  const usageId = (payload.id ?? '').toString() || '(unknown)';

  return [
    `Recorded ${input.outcome} usage for concept ${conceptId}`,
    `  usage row: ${usageId}`,
    `  trace_id:  ${traceId}`,
    `  effect:    ${
      input.outcome === 'success'
        ? 'credits the concept — raises its Bayesian relevance'
        : input.outcome === 'failure'
          ? 'no credit, +1 load — lowers relevance'
          : 'load event only — mild pull toward the 0.5 prior'
    }`,
    `Recorded in ${duration}ms`,
  ].join('\n');
}
