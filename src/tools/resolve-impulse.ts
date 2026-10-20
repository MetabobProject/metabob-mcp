// Contract (input schema, behaviour): SPEC §resolve_impulse
/**
 * resolve_impulse — a GENERAL impulse-resolve passthrough, so an operator agent
 * can resolve or write ANY shape through MCP instead of raw `curl … /resolve`
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
 * The shape may be a write, so it is sent once and never retried.
 *
 * It is an allowlist: a shape is resolved only when READS_THROUGH_ESCAPE_HATCH (plain
 * reads) or WRITES_THROUGH_ESCAPE_HATCH (memory with no dedicated tool) lists it; anything
 * else is refused before any request, with COORDINATION_WRITES giving the reason and the
 * alternative for the known writes. This keeps the cockpit from being a route to a
 * substrate shell, git, restarts, credit or the graded record; it is not a security
 * boundary, which belongs to each producer. SPEC §resolve_impulse
 */

import { z } from 'zod';
import type { AnalysisAPIClient } from '../api-client.js';
import { RESOLVE_MAX_TIMEOUT_MS, describeResolveFailure, resolveShape } from '../attachment.js';

const MAX_CONTENT = 2048;

const LEASE = (shape: string, what: string, instead: string) =>
  `${shape} is the substrate's own coordination (${what}); an agent does not take or release it. ${instead}. If a lease looks stuck or held by something other than the system, record a finding with its holder, name and expiry`;
const GRADED = (shape: string) =>
  `${shape} writes the substrate's graded record; an agent never writes a trace. Dispatch the work as a goal, so goal-host traces it and its judge grades it`;
const POLICY = (shape: string) =>
  `${shape} changes system policy, an operator's decision and not an agent's; this cockpit key carries no operator authority. Ask the person, or record a finding proposing the change`;
const LEARNED = (shape: string) =>
  `${shape} writes what the substrate has learned (activities, scores, relevance, sequences, attributions); the system learns these from its own graded work, and an agent writing them is hand-feeding it. Dispatch a goal, or record a finding with what you observed`;
const EVIDENCE = (shape: string) =>
  `${shape} records test or gate evidence, which the gates write themselves; an agent-written report would stand in for a check that never ran. Run the check, or dispatch it as a goal`;
const SURFACE = (shape: string) =>
  `${shape} writes the human surface's own records; the person's questions, answers and feedback go through that surface as theirs, never written by an agent`;
const TOOL = (shape: string, tool: string) =>
  `${shape} has a dedicated tool: use ${tool}, which checks its input and records provenance`;

/**
 * Why each write an agent does not make through the escape hatch is refused, and what
 * to do instead. Every other write is refused too (WRITES_THROUGH_ESCAPE_HATCH is the
 * allowlist); this table gives the reason for the ones that are known.
 */
// @anchor coordination-writes
export const COORDINATION_WRITES: Readonly<Record<string, string>> = {
  maintenanceLease_write: LEASE('maintenanceLease_write', 'maintenance windows, the auto-pick lane', 'To have maintenance done, dispatch it as a goal'),
  substrateGapLease_write: LEASE('substrateGapLease_write', "a gap's landing lease; landing a gap is the system's work", 'To have a gap closed, let the system land it or dispatch it as a goal'),
  activityExecutionTrace_write: GRADED('activityExecutionTrace_write'),
  execution_write: GRADED('execution_write'),
  goal_verification_label_write:
    "goal_verification_label_write is the oracle corpus; provide_feedback is the one path into it from this cockpit, and records your verdict as an automated label with the operator folded in",
  poolImpulse_write:
    "poolImpulse_write adds content to a running walk, and the substrate does not yet stamp who contributed it; until it does, an agent does not feed walks. Dispatch a goal, or record a finding with what the walk is missing",
  substrateGap_write:
    "substrateGap_write files a gap; gaps come from the system's own detectors, and an agent-filed gap counts as hand-fed. Record a finding instead (record_finding), and the detectors and other agents see it",
  fs_write:
    "fs_write writes files on a vessel; a change to the substrate goes through a dispatched goal or a reviewed commit, never a direct write",
  pushPolicy_write: POLICY('pushPolicy_write'),
  llmModelPolicy_write: POLICY('llmModelPolicy_write'),
  docFixPolicy_write: POLICY('docFixPolicy_write'),
  renderPolicy_write: POLICY('renderPolicy_write'),
  activityComposition_write: LEARNED('activityComposition_write'),
  activityFeedback_write: LEARNED('activityFeedback_write'),
  activityTemplate_write: LEARNED('activityTemplate_write'),
  activityVariant_write: LEARNED('activityVariant_write'),
  code_modification_proposal_write: LEARNED('code_modification_proposal_write'),
  conceptCreditDecontaminate_write: LEARNED('conceptCreditDecontaminate_write'),
  conceptSequence_write: LEARNED('conceptSequence_write'),
  conceptSignatureUpsert_write: LEARNED('conceptSignatureUpsert_write'),
  executionSequences_write: LEARNED('executionSequences_write'),
  goalSeeking_write: LEARNED('goalSeeking_write'),
  impulseRelevance_write: LEARNED('impulseRelevance_write'),
  impulseRelevancePenalty_write: LEARNED('impulseRelevancePenalty_write'),
  interventionRefused_write: LEARNED('interventionRefused_write'),
  loadAttribution_write: LEARNED('loadAttribution_write'),
  sensitivity_evidence_write: LEARNED('sensitivity_evidence_write'),
  shapeGapResolution_write: LEARNED('shapeGapResolution_write'),
  shapeScore_write: LEARNED('shapeScore_write'),
  similarState_write: LEARNED('similarState_write'),
  solicitationHeartbeat_write: LEARNED('solicitationHeartbeat_write'),
  toolArgumentPattern_write: LEARNED('toolArgumentPattern_write'),
  toolUsage_write: LEARNED('toolUsage_write'),
  test_audit_report_write: EVIDENCE('test_audit_report_write'),
  test_registration_write: EVIDENCE('test_registration_write'),
  test_report_write: EVIDENCE('test_report_write'),
  interactorAssertion_write: SURFACE('interactorAssertion_write'),
  interactorAttachment_write: SURFACE('interactorAttachment_write'),
  interactorDismiss_write: SURFACE('interactorDismiss_write'),
  interactorEvent_write: SURFACE('interactorEvent_write'),
  uiFeedback_write: SURFACE('uiFeedback_write'),
  uiPanel_write: SURFACE('uiPanel_write'),
  uiQuestion_write: SURFACE('uiQuestion_write'),
  concept_create_write: TOOL('concept_create_write', 'concept_create'),
  conceptLink_write: TOOL('conceptLink_write', 'concept_link'),
  conceptUsage_write: TOOL('conceptUsage_write', 'concept_record_usage'),
  solicitationResponse_write: TOOL('solicitationResponse_write', 'submit_resolution'),
  concept_write:
    "concept_write overwrites a concept in the system's memory; add to memory with concept_create, and correct a wrong concept with concept_supersede_write, which keeps the history",
  concept_delete_write:
    "concept_delete_write removes a concept from the system's memory, which belongs to the system; correct a wrong concept with concept_supersede_write, which keeps the history",
  concept_retire_write:
    "concept_retire_write retires a concept through the system's own lifecycle; correct a wrong concept with concept_supersede_write, or record a finding",
};

/**
 * The writes an agent may make through the escape hatch, with why: the ones that add to
 * the system's memory and have no dedicated tool.
 */
// @anchor escape-hatch-writes
export const WRITES_THROUGH_ESCAPE_HATCH: Readonly<Record<string, string>> = {
  memoryNote_write: 'adds a note to the system memory, as the session hooks do (law 10: memory belongs to the system)',
  concept_supersede_write: 'records a correction that keeps the history, so a wrong claim stops propagating',
};

/**
 * The shapes an agent may read through the escape hatch: records, reports, statistics,
 * summaries and policies, each a plain read. Anything else is refused, whatever its name
 * says, because a name does not tell a read from an action (`bash`, `code_replace_lines`,
 * `surrealdb_import` and `llm_completion` all read like reads). tests/fixtures/
 * registry-vocabulary.json decides every shape of a live vocabulary, and the test holds
 * this list to it.
 */
// @anchor escape-hatch-reads
export const READS_THROUGH_ESCAPE_HATCH: ReadonlySet<string> = new Set([
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
  'reachable_unlearned_report', 'relatedConcepts', 'renderPolicy', 'repairPolicy',
  'resolver_pattern_report', 'resolver_tier_cost_summary', 'selectionEntropy',
  'shape_producer_inventory', 'substrateGap', 'system_load_report', 'templateAuditReport',
  'template_audit_report', 'template_invocation_history_report', 'template_success_ranking_24h',
  'thompson_posterior', 'toolRiskProfile', 'topologyCoverage', 'traceAggregateReport',
  'traceCompletenessReport', 'trace_failure_pattern_report', 'trace_search',
  'unknown_shape_report', 'variantMetricsSummary', 'vessel_completeness_report',
  'vessel_demand_report', 'vessel_health_report',
]);

/** Why `shape` is refused through the escape hatch, or null when it may be resolved. */
export function escapeHatchRefusal(shape: string): string | null {
  if (READS_THROUGH_ESCAPE_HATCH.has(shape) || Object.hasOwn(WRITES_THROUGH_ESCAPE_HATCH, shape)) return null;
  if (Object.hasOwn(COORDINATION_WRITES, shape)) return COORDINATION_WRITES[shape]!;
  if (shape.endsWith('_write')) {
    return `${shape} is a write this cockpit does not make through the escape hatch: the substrate writes its own record, learned state and policy. Use a dedicated tool if one fits (record_finding, concept_create, concept_link, concept_record_usage, provide_feedback, submit_resolution), or dispatch a goal`;
  }
  return `${shape} is not one of the reads this escape hatch allows: it runs or changes something on the substrate (a shell, git, a restart, a cutover, a compose, a dispatch, credit), or it has not been reviewed as a plain read. Dispatch the work as a goal, so goal-host routes it and its judge grades it, or use a dedicated tool`;
}

/** The request cap: RESOLVE_IMPULSE_TIMEOUT_MS (default 30 s), never above 60 s. */
function timeoutMs(): number {
  const ms = parseInt(process.env.RESOLVE_IMPULSE_TIMEOUT_MS || '30000', 10);
  return Math.min(Number.isFinite(ms) && ms > 0 ? ms : 30_000, RESOLVE_MAX_TIMEOUT_MS);
}

export const ResolveImpulseTool = {
  name: 'resolve_impulse',
  description:
    "ADVANCED escape hatch: resolve one of the substrate's plain reads (records, reports, statistics, summaries, policies) via MCP instead of raw `curl /resolve` POSTs, e.g. memoryNote, traceAggregateReport, llmSpendSummary. The pointer goes to discovery's /resolve, which forwards it to the shape's producer. Prefer the dedicated tools when they fit — run_goal / run_goal_async (goals), goal_reasoning (walk inspection), provide_feedback (oracle verdicts). pointer merges into { type: shape, ... }. Returns the producer's HTTP status and raw JSON response. Only allowlisted shapes resolve: plain reads, and the two memory writes memoryNote_write and concept_supersede_write. Anything that runs or changes something (a shell, git, a restart, a cutover, a compose, a dispatch, credit, traces, policy) is refused with what to do instead: dispatch a goal, or use the dedicated tool.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      shape: {
        type: 'string',
        description: 'The shape (pointer.type) to resolve: one of the allowlisted reads (e.g. memoryNote, traceAggregateReport) or memoryNote_write / concept_supersede_write.',
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
  // The effective type (pointer.type overrides shape); own keys only, so a shape named like an
  // Object.prototype member is not a listed write.
  const why = typeof pointer.type === 'string' ? escapeHatchRefusal(pointer.type) : null;
  if (why) {
    return `resolve_impulse: refused: ${why}.`;
  }

  let res;
  try {
    res = await resolveShape(pointer, { timeoutMs: timeoutMs() });
  } catch (err) {
    return `resolve_impulse: ${describeResolveFailure(err)}`;
  }

  const header = `resolve_impulse ${input.shape} → discovery /resolve [${res.status}]`;
  return `${header}\n${truncate(JSON.stringify(res.body, null, 2))}`;
}
