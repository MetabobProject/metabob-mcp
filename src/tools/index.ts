import * as InitWorkspace from './init-workspace.js';
import * as GetProblems from './get-problems.js';
import * as SearchCodebase from './search-codebase.js';
import * as PredictCochanges from './predict-cochanges.js';
import * as AnalyzeImpact from './analyze-impact.js';
import * as AnnotateComponent from './annotate-component.js';
import * as MarkComplete from './mark-complete.js';
import * as GetMetrics from './get-metrics.js';
import * as AssignGitChanges from './assign-git-changes.js';
import * as GetAnalysisContext from './get-analysis-context.js';
import * as RecordFinding from './record-finding.js';
import * as ConceptSearch from './concept-search.js';
import * as ConceptNeighbors from './concept-neighbors.js';
import * as ConceptUsageStats from './concept-usage-stats.js';
import * as ConceptSequence from './concept-sequence.js';
import * as ConceptLink from './concept-link.js';
import * as ConceptCreate from './concept-create.js';
import * as ConceptRecordUsage from './concept-record-usage.js';
import * as RunGoal from './run-goal.js';
import * as RunGoalAsync from './run-goal-async.js';
import * as GoalStatus from './goal-status.js';
import * as GoalReasoning from './goal-reasoning.js';
import * as ProvideFeedback from './provide-feedback.js';
import * as RegistryQuery from './registry-query.js';
import * as ExecutionTrace from './execution-trace.js';
import * as ResolveImpulse from './resolve-impulse.js';
import * as PathActivity from './path-activity.js';
import * as PullAssignedWork from './pull-assigned-work.js';
import * as SubmitResolution from './submit-resolution.js';
import { substrateRefusal } from '../attachment.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (input: any, apiClient: any, sessionId: string, localStore?: any) => Promise<string>;
  validateInput: (input: any) => any;
}

export const TOOL_REGISTRY: Record<string, Tool> = {
  init_workspace: {
    ...InitWorkspace.InitWorkspaceTool,
    handler: InitWorkspace.handle,
    validateInput: (i: any) => InitWorkspace.InputSchema.parse(i),
  },
  get_problems: {
    ...GetProblems.GetProblemsTool,
    handler: GetProblems.handle,
    validateInput: (i: any) => GetProblems.InputSchema.parse(i),
  },
  search_codebase: {
    ...SearchCodebase.SearchCodebaseTool,
    handler: SearchCodebase.handle,
    validateInput: (i: any) => SearchCodebase.InputSchema.parse(i),
  },
  predict_cochanges: {
    ...PredictCochanges.PredictCochangesTool,
    handler: PredictCochanges.handle,
    validateInput: (i: any) => PredictCochanges.InputSchema.parse(i),
  },
  analyze_impact: {
    ...AnalyzeImpact.AnalyzeImpactTool,
    handler: AnalyzeImpact.handle,
    validateInput: (i: any) => AnalyzeImpact.InputSchema.parse(i),
  },
  annotate_component: {
    ...AnnotateComponent.AnnotateComponentTool,
    handler: AnnotateComponent.handle,
    validateInput: (i: any) => AnnotateComponent.InputSchema.parse(i),
  },
  mark_complete: {
    ...MarkComplete.MarkCompleteTool,
    handler: MarkComplete.handle,
    validateInput: (i: any) => MarkComplete.InputSchema.parse(i),
  },
  get_metrics: {
    ...GetMetrics.GetMetricsTool,
    handler: GetMetrics.handle,
    validateInput: (i: any) => GetMetrics.InputSchema.parse(i),
  },
  assign_git_changes: {
    ...AssignGitChanges.AssignGitChangesTool,
    handler: AssignGitChanges.handle,
    validateInput: (i: any) => AssignGitChanges.InputSchema.parse(i),
  },
  get_analysis_context: {
    ...GetAnalysisContext.GetAnalysisContextTool,
    handler: GetAnalysisContext.handle,
    validateInput: (i: any) => GetAnalysisContext.InputSchema.parse(i),
  },
  record_finding: {
    ...RecordFinding.RecordFindingTool,
    handler: RecordFinding.handle,
    validateInput: (i: any) => RecordFinding.InputSchema.parse(i),
  },
  concept_search: {
    ...ConceptSearch.ConceptSearchTool,
    handler: ConceptSearch.handle,
    validateInput: (i: any) => ConceptSearch.InputSchema.parse(i),
  },
  concept_neighbors: {
    ...ConceptNeighbors.ConceptNeighborsTool,
    handler: ConceptNeighbors.handle,
    validateInput: (i: any) => ConceptNeighbors.InputSchema.parse(i),
  },
  concept_usage_stats: {
    ...ConceptUsageStats.ConceptUsageStatsTool,
    handler: ConceptUsageStats.handle,
    validateInput: (i: any) => ConceptUsageStats.InputSchema.parse(i),
  },
  concept_sequence: {
    ...ConceptSequence.ConceptSequenceTool,
    handler: ConceptSequence.handle,
    validateInput: (i: any) => ConceptSequence.InputSchema.parse(i),
  },
  concept_link: {
    ...ConceptLink.ConceptLinkTool,
    handler: ConceptLink.handle,
    validateInput: (i: any) => ConceptLink.InputSchema.parse(i),
  },
  concept_create: {
    ...ConceptCreate.ConceptCreateTool,
    handler: ConceptCreate.handle,
    validateInput: (i: any) => ConceptCreate.InputSchema.parse(i),
  },
  concept_record_usage: {
    ...ConceptRecordUsage.ConceptRecordUsageTool,
    handler: ConceptRecordUsage.handle,
    validateInput: (i: any) => ConceptRecordUsage.InputSchema.parse(i),
  },
  run_goal: {
    ...RunGoal.RunGoalTool,
    handler: RunGoal.handle,
    validateInput: (i: any) => RunGoal.InputSchema.parse(i),
  },
  run_goal_async: {
    ...RunGoalAsync.RunGoalAsyncTool,
    handler: RunGoalAsync.handle,
    validateInput: (i: any) => RunGoalAsync.InputSchema.parse(i),
  },
  goal_status: {
    ...GoalStatus.GoalStatusTool,
    handler: GoalStatus.handle,
    validateInput: (i: any) => GoalStatus.InputSchema.parse(i),
  },
  goal_reasoning: {
    ...GoalReasoning.GoalReasoningTool,
    handler: GoalReasoning.handle,
    validateInput: (i: any) => GoalReasoning.InputSchema.parse(i),
  },
  provide_feedback: {
    ...ProvideFeedback.ProvideFeedbackTool,
    handler: ProvideFeedback.handle,
    validateInput: (i: any) => ProvideFeedback.InputSchema.parse(i),
  },
  registry_query: {
    ...RegistryQuery.RegistryQueryTool,
    handler: RegistryQuery.handle,
    validateInput: (i: any) => RegistryQuery.InputSchema.parse(i),
  },
  path_activity: {
    ...PathActivity.PathActivityTool,
    handler: PathActivity.handle,
    validateInput: (i: any) => PathActivity.InputSchema.parse(i),
  },
  execution_trace: {
    ...ExecutionTrace.ExecutionTraceTool,
    handler: ExecutionTrace.handle,
    validateInput: (i: any) => ExecutionTrace.InputSchema.parse(i),
  },
  resolve_impulse: {
    ...ResolveImpulse.ResolveImpulseTool,
    handler: ResolveImpulse.handle,
    validateInput: (i: any) => ResolveImpulse.InputSchema.parse(i),
  },
  pull_assigned_work: {
    ...PullAssignedWork.PullAssignedWorkTool,
    handler: PullAssignedWork.handle,
    validateInput: (i: any) => PullAssignedWork.InputSchema.parse(i),
  },
  submit_resolution: {
    ...SubmitResolution.SubmitResolutionTool,
    handler: SubmitResolution.handle,
    validateInput: (i: any) => SubmitResolution.InputSchema.parse(i),
  },
};

export function getAllTools(): Tool[] {
  return Object.values(TOOL_REGISTRY);
}

export function getTool(name: string): Tool | undefined {
  return TOOL_REGISTRY[name];
}

/**
 * Tools whose whole job is a keyed substrate call (SPEC §substrate-goal-tools,
 * SPEC §concept-graph-tools). The mixed tools (get_problems, record_finding,
 * mark_complete, get_analysis_context) keep their local half and check the
 * attachment only for their substrate half (`src/tools/_findings.ts@conceptDbUnavailable`).
 */
export const SUBSTRATE_TOOLS: ReadonlySet<string> = new Set([
  'run_goal',
  'run_goal_async',
  'goal_status',
  'goal_reasoning',
  'provide_feedback',
  'registry_query',
  'execution_trace',
  'path_activity',
  'resolve_impulse',
  'concept_search',
  'concept_neighbors',
  'concept_usage_stats',
  'concept_sequence',
  'concept_link',
  'concept_create',
  'concept_record_usage',
]);

/**
 * The one check both dispatch planes (MCP stdio and the loopback resolver) run
 * before a substrate tool: null to proceed, else the attachment's one-line
 * named cause, returned in place of the tool's output. The key is proven
 * before any keyed call (CONFORMANCE §c3-identity).
 */
export async function substrateToolRefusal(name: string): Promise<string | null> {
  return SUBSTRATE_TOOLS.has(name) ? substrateRefusal() : null;
}
