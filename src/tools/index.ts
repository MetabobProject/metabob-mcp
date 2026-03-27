/**
 * Tool registry for all MCP tools
 */

import * as GetPriorityIssues from './get-priority-issues.js';
import * as SearchCodebase from './search-codebase.js';
import * as AnnotateComponent from './annotate-component.js';
import * as SuggestRelatedChanges from './suggest-related-changes.js';
import * as AnalyzeChangeImpact from './analyze-change-impact.js';
import * as MarkProblemComplete from './mark-problem-complete.js';
import * as GenerateImplementationSpec from './generate-implementation-spec.js';
import * as InitWorkspace from './init-workspace.js';
import * as Activity from './activity.js';

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (input: any, apiClient: any, sessionId: string) => Promise<string>;
  validateInput: (input: any) => any;
}

export const TOOL_REGISTRY: Record<string, Tool> = {
  // Analysis tools
  get_priority_issues: {
    ...GetPriorityIssues.GetPriorityIssuesTool,
    handler: GetPriorityIssues.handle,
    validateInput: (input: any) => GetPriorityIssues.InputSchema.parse(input),
  },
  search_codebase: {
    ...SearchCodebase.SearchCodebaseTool,
    handler: SearchCodebase.handle,
    validateInput: (input: any) => SearchCodebase.InputSchema.parse(input),
  },
  annotate_component: {
    ...AnnotateComponent.AnnotateComponentTool,
    handler: AnnotateComponent.handle,
    validateInput: (input: any) => AnnotateComponent.InputSchema.parse(input),
  },
  suggest_related_changes: {
    ...SuggestRelatedChanges.SuggestRelatedChangesTool,
    handler: SuggestRelatedChanges.handle,
    validateInput: (input: any) => SuggestRelatedChanges.InputSchema.parse(input),
  },
  analyze_change_impact: {
    ...AnalyzeChangeImpact.AnalyzeChangeImpactTool,
    handler: AnalyzeChangeImpact.handle,
    validateInput: (input: any) => AnalyzeChangeImpact.InputSchema.parse(input),
  },
  mark_problem_complete: {
    ...MarkProblemComplete.MarkProblemCompleteTool,
    handler: MarkProblemComplete.handle,
    validateInput: (input: any) => MarkProblemComplete.InputSchema.parse(input),
  },
  generate_implementation_spec: {
    ...GenerateImplementationSpec.GenerateImplementationSpecTool,
    handler: GenerateImplementationSpec.handle,
    validateInput: (input: any) => GenerateImplementationSpec.InputSchema.parse(input),
  },

  // Workspace initialization
  init_workspace: {
    ...InitWorkspace.InitWorkspaceTool,
    handler: InitWorkspace.handle,
    validateInput: (input: any) => InitWorkspace.InputSchema.parse(input),
  },

  // Activity tools (connection slots & resolution)
  resolve_impulse: {
    ...Activity.ResolveImpulseTool,
    handler: Activity.handleResolveImpulse,
    validateInput: (input: any) => Activity.ResolveImpulseInputSchema.parse(input),
  },
  run_goal: {
    ...Activity.RunGoalTool,
    handler: Activity.handleRunGoal,
    validateInput: (input: any) => Activity.RunGoalInputSchema.parse(input),
  },
  get_recommendations: {
    ...Activity.GetRecommendationsTool,
    handler: Activity.handleGetRecommendations,
    validateInput: (input: any) => Activity.GetRecommendationsInputSchema.parse(input),
  },
  submit_trace: {
    ...Activity.SubmitTraceTool,
    handler: Activity.handleSubmitTrace,
    validateInput: (input: any) => Activity.SubmitTraceInputSchema.parse(input),
  },
};

export function getAllTools() {
  return Object.values(TOOL_REGISTRY);
}

export function getTool(name: string): Tool | undefined {
  return TOOL_REGISTRY[name];
}
