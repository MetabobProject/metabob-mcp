// Contract (input schema, behaviour): SPEC §concept_record_usage
/**
 * concept_record_usage — the direct write into concept-db's relevance model.
 *
 * The other concept_* tools read the graph; the findings plane creates
 * concepts. This tool is the missing edge: it lets an MCP-side agent
 * ATTRIBUTE an outcome to a concept it used, feeding concept-db's usage
 * chokepoint (the `conceptUsage_write` shape). concept-db folds the outcome into
 * the Beta-Binomial posterior mean `(times_succeeded + 1) / (times_loaded + 2)`:
 *
 *   - success  → a real credit; raises the concept's relevance
 *   - failure  → grows the load denominator with no credit; lowers relevance
 *   - neutral  → a load event (denominator only); mild deflation toward 0.5
 *
 * Reads through the conceptSearch / conceptGraph shapes record no load event,
 * so without this tool MCP would influence relevance only through cross-vessel
 * goal executions. It makes the agent a first-class, deliberate contributor —
 * the same interface concept-db's own execution observer uses when a task
 * completes.
 *
 * Written as `conceptUsage_write` through discovery `POST /resolve`
 * (src/tools/_concept-db.ts), once — a write is never retried.
 * CONFORMANCE §c11-attachment-model
 */

import { z } from 'zod';
import { plainConceptId } from './_concept-content.js';
import type { AnalysisAPIClient } from '../api-client.js';
import { recordUsage } from './_concept-db.js';
import { makeUsageTraceId } from './_findings.js';

export const ConceptRecordUsageTool = {
  name: 'concept_record_usage',
  description:
    "Record an outcome for a concept you used, feeding concept-db's relevance model directly. concept-db computes relevance as a Bayesian success rate (times_succeeded+1)/(times_loaded+2): success raises it, failure/neutral grow the load count without credit. Use this to credit a concept whose guidance led to a good result (success), penalize one that misled you (failure), or just register that you loaded it (neutral). This is the deliberate, first-class way an agent teaches the graph what is actually useful — reads through concept_search record no load (concept-db's conceptSearch shape records none), so this is how a concept you relied on gets credit.",
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
}

export async function handle(
  input: ConceptRecordUsageInput,
  _apiClient: AnalysisAPIClient,
): Promise<string> {
  const start = Date.now();

  // Same normalisation as fetchConceptById and mark_complete: concept-db hands
  // back ids wrapped in ⟨⟩, and an unstripped id resolves to nothing while the
  // call still reports success.
  const conceptId = plainConceptId(input.concept_id);
  const traceId = input.trace_id ?? makeUsageTraceId();

  const usageData: Record<string, unknown> = { concept_id: conceptId, trace_id: traceId, outcome: input.outcome };
  if (input.activity_id) usageData.activity_id = input.activity_id;
  if (input.task_id) usageData.task_id = input.task_id;

  const recorded = await recordUsage(usageData);
  const duration = Date.now() - start;

  if (!recorded.ok) {
    return `concept_record_usage: ${recorded.error}`;
  }

  const payload = recorded.value as UsageResponse;
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
