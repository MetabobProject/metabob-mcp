// Contract (input schema, behaviour): SPEC §resolve_impulse
/**
 * resolve_impulse — a general impulse-resolve passthrough, so an operator agent
 * can resolve or write any shape through MCP instead of raw `curl … /resolve`
 * POSTs.
 *
 * ADVANCED / ESCAPE HATCH: prefer the dedicated tools when they fit — run_goal /
 * run_goal_async for goals, goal_reasoning for walk inspection, provide_feedback
 * for oracle-corpus verdicts. Reach for resolve_impulse only when no dedicated
 * tool covers the shape.
 *
 * A thin passthrough of the attachment's resolve() (src/attachment.ts@attachment-resolve):
 * `{ pointer: { type: shape, ...pointer } }` to discovery `POST /resolve`, which
 * picks the shape's producer and forwards it (CONFORMANCE §c11-attachment-model).
 * It refuses no shape: what a key may do is each producer's decision. KNOWN_READS
 * only classifies: a known read is retried after a timeout and passes the read-only-key
 * gate; any other shape may be a write, so it is sent once and never retried. SPEC §resolve_impulse
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_MAX_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

const MAX_CONTENT = 2048;

/** The trace reads: cut at their timeout, the query keeps running in activity-api, so they are not retried. */
const TRACE_READS: ReadonlySet<string> = new Set(['activityExecutionTrace', 'executionTraceList', 'executionTraces']);

/**
 * The shapes known to be plain reads (records, reports, statistics, summaries, policies),
 * reviewed by name and by a source check of their producers. A known read is sent as a read:
 * retried when cut at its producer's timeout, and allowed with a read-only key. A shape not
 * listed is treated as a possible write: sent once, and not sent with a read-only key.
 */
// @anchor known-reads
export const KNOWN_READS: ReadonlySet<string> = new Set([
  'activeDispatches', 'activity', 'activityExecutionTrace', 'activityMetrics', 'activityTemplate',
  'activityTemplatesByMetrics', 'activity_metrics', 'activity_search', 'activity_template',
  'bodyHonestyPolicy', 'compositionGraph', 'compositionSuccess', 'composition_coverage_report',
  'concept', 'conceptGraph', 'conceptSearch', 'conceptSequence', 'conceptUsageStats',
  'concept_search_by_source', 'contextThompsonScores', 'docFixPolicy', 'edge_liveness_report',
  'executionTraceList', 'executionTraces', 'extractionPolicy', 'failureCountReport',
  'failure_count_report', 'failure_mode_summary', 'fossilRankReport', 'fossil_rank_report',
  'goalExecutionPath', 'goalWalkState', 'goal_summary', 'goal_verification_label',
  'groupedExecutionStats', 'impulseRelevance', 'learningMode', 'learningPolicy',
  'learning_transfer_report', 'lessonExecutionPolicy', 'llmModelPolicy', 'llmQuotaState',
  'llmSpendSummary', 'llmSpendSummaryNode', 'loadAttribution', 'load_attribution_report',
  'maintenanceLease', 'memoryNote', 'operational_state', 'pathwayReusePolicy', 'pushPolicy',
  'reachable_unlearned_report', 'record_read', 'relatedConcepts', 'renderPolicy', 'repairPolicy',
  'resolver_pattern_report', 'resolver_tier_cost_summary', 'selectionEntropy',
  'shape_producer_inventory', 'substrateGap', 'system_load_report', 'templateAuditReport',
  'template_audit_report', 'template_invocation_history_report', 'template_success_ranking_24h',
  'thompson_posterior', 'toolRiskProfile', 'topologyCoverage', 'traceAggregateReport',
  'traceCompletenessReport', 'trace_failure_pattern_report', 'trace_search',
  'unknown_shape_report', 'variantMetricsSummary', 'vessel_completeness_report',
  'vessel_demand_report', 'vessel_health_report',
]);

/** The request cap: RESOLVE_IMPULSE_TIMEOUT_MS (default 30 s), never above 60 s. */
function timeoutMs(): number {
  const ms = parseInt(process.env.RESOLVE_IMPULSE_TIMEOUT_MS || '30000', 10);
  return Math.min(Number.isFinite(ms) && ms > 0 ? ms : 30_000, RESOLVE_MAX_TIMEOUT_MS);
}

export const ResolveImpulseTool = {
  name: 'resolve_impulse',
  description:
    "ADVANCED escape hatch: resolve any substrate shape via MCP instead of raw `curl /resolve` POSTs — reads (e.g. memoryNote, traceAggregateReport, record_read) and writes (e.g. record_write, memoryNote_write). The pointer goes to discovery's /resolve, which forwards it with your key to the shape's producer; what your key may do is the producer's decision. Prefer the dedicated tools when they fit — run_goal / run_goal_async (goals), goal_reasoning (walk inspection), provide_feedback (oracle verdicts), concept_create / record_finding (memory and the ledger). pointer merges into { type: shape, ... }. Returns the producer's HTTP status and raw JSON response. A shape that is not a known read is sent once and never retried, since it may be a write.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      shape: {
        type: 'string',
        description: 'The shape (pointer.type) to resolve, e.g. memoryNote, record_read, record_write.',
      },
      pointer: {
        type: 'object',
        description: 'Extra pointer fields merged into { type: shape, ... } (e.g. { note_type: "feedback", limit: 2 }).',
        additionalProperties: true,
      },
    },
    required: ['shape'],
  },
};

export const InputSchema = z.object({
  shape: z.string().min(1, 'shape is required'),
  pointer: z.record(z.unknown()).optional(),
});

export type ResolveImpulseInput = z.infer<typeof InputSchema>;

function truncate(text: string): string {
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}\n… [truncated ${text.length - MAX_CONTENT} chars]` : text;
}

export async function handle(input: ResolveImpulseInput, _apiClient: AnalysisAPIClient): Promise<string> {
  const pointer: Record<string, unknown> = { type: input.shape, ...(input.pointer ?? {}) };
  // The effective type: pointer.type overrides shape.
  const type = String(pointer.type);

  let res;
  try {
    // A known read is a read (no claim, transient retries); any other shape is sent once, as a write.
    // A trace read cut at its timeout leaves the query running in activity-api, so it is not repeated (SPEC §attachment).
    res = await resolveShape(pointer, { timeoutMs: timeoutMs(), read: KNOWN_READS.has(type), ...(TRACE_READS.has(type) ? { noTimeoutRetry: true } : {}) });
  } catch (err) {
    return `resolve_impulse: ${describeResolveFailure(err)}`;
  }

  const header = `resolve_impulse ${input.shape} → discovery /resolve [${res.status}]`;
  return `${header}\n${truncate(JSON.stringify(res.body, null, 2))}`;
}
