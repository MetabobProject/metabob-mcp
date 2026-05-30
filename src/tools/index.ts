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
import * as ConceptSearch from './concept-search.js';

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
  concept_search: {
    ...ConceptSearch.ConceptSearchTool,
    handler: ConceptSearch.handle,
    validateInput: (i: any) => ConceptSearch.InputSchema.parse(i),
  },
};

export function getAllTools(): Tool[] {
  return Object.values(TOOL_REGISTRY);
}

export function getTool(name: string): Tool | undefined {
  return TOOL_REGISTRY[name];
}
