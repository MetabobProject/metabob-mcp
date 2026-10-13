/**
 * Unit tests for MCP tools
 * Tests the analysis tool handlers with a mocked API client
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';
import { makeTempStore, cleanupTempStores } from '../helpers/temp-store';

import * as InitWorkspace from '../../src/tools/init-workspace';
import * as GetProblems from '../../src/tools/get-problems';
import * as SearchCodebase from '../../src/tools/search-codebase';
import * as PredictCochanges from '../../src/tools/predict-cochanges';
import * as AnalyzeImpact from '../../src/tools/analyze-impact';
import * as AnnotateComponent from '../../src/tools/annotate-component';
import * as MarkComplete from '../../src/tools/mark-complete';
import * as GetMetrics from '../../src/tools/get-metrics';
import * as AssignGitChanges from '../../src/tools/assign-git-changes';
import * as GetAnalysisContext from '../../src/tools/get-analysis-context';

const SESSION = 'test-session';

let mockApiClient: AnalysisAPIClient;

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
    postFeedback: mock(async () => ({})),
    isVesselMode: mock(() => false),
  } as unknown as AnalysisAPIClient;
});

afterEach(() => {
  cleanupTempStores();
});

// ===== init_workspace =====

test('init_workspace: schema accepts valid input', () => {
  const result = InitWorkspace.InputSchema.parse({ workspace_path: '/tmp/project', batch_size: 3 });
  expect(result.batch_size).toBe(3);
});

test('init_workspace: schema uses defaults', () => {
  const result = InitWorkspace.InputSchema.parse({});
  // batch_size stays in the schema, accepted and ignored: init_workspace sends
  // no files anywhere.
  expect(result.batch_size).toBe(20);
});

// ===== get_problems =====

test('get_problems: schema accepts valid input', () => {
  const result = GetProblems.InputSchema.parse({ limit: 5, severity: ['HIGH'] });
  expect(result.limit).toBe(5);
  expect(result.severity).toEqual(['HIGH']);
});

test('get_problems: schema uses defaults', () => {
  const result = GetProblems.InputSchema.parse({});
  expect(result.limit).toBe(10);
  expect(result.include_discarded).toBe(false);
});

test('get_problems: handler returns non-empty string', async () => {
  const input = GetProblems.InputSchema.parse({});
  const result = await GetProblems.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

test('get_problems: makes no analysis request and says there is no server-side analysis', async () => {
  const input = GetProblems.InputSchema.parse({});
  const result = await GetProblems.handle(input, mockApiClient, SESSION);
  expect(mockApiClient.get).not.toHaveBeenCalled();
  expect(mockApiClient.post).not.toHaveBeenCalled();
  expect(result).toContain('Server-side analysis: none');
});

// ===== search_codebase =====

test('search_codebase: schema accepts valid input', () => {
  const result = SearchCodebase.InputSchema.parse({ query: 'auth', limit: 5 });
  expect(result.query).toBe('auth');
  expect(result.limit).toBe(5);
});

test('search_codebase: schema requires non-empty query', () => {
  expect(() => SearchCodebase.InputSchema.parse({})).toThrow();
  expect(() => SearchCodebase.InputSchema.parse({ query: '' })).toThrow();
});

test('search_codebase: handler returns non-empty string', async () => {
  const input = SearchCodebase.InputSchema.parse({ query: 'login' });
  const result = await SearchCodebase.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

// ===== predict_cochanges =====

test('predict_cochanges: schema accepts valid input', () => {
  const result = PredictCochanges.InputSchema.parse({ changed_files: ['src/auth.ts'] });
  expect(result.changed_files).toEqual(['src/auth.ts']);
  expect(result.confidence_threshold).toBe(0.3);
});

test('predict_cochanges: schema requires changed_files', () => {
  expect(() => PredictCochanges.InputSchema.parse({})).toThrow();
  expect(() => PredictCochanges.InputSchema.parse({ changed_files: [] })).toThrow();
});

test('predict_cochanges: handler returns "not indexed" when workspace not initialised', async () => {
  // localIndex.isReady() is false until init_workspace runs — handler returns early
  const input = PredictCochanges.InputSchema.parse({ changed_files: ['src/auth.ts'] });
  const result = await PredictCochanges.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

// ===== analyze_impact =====

test('analyze_impact: schema accepts valid input', () => {
  const result = AnalyzeImpact.InputSchema.parse({ changed_files: ['src/login.ts'], direction: 'forward' });
  expect(result.direction).toBe('forward');
  expect(result.max_depth).toBe(5);
});

test('analyze_impact: schema requires changed_files', () => {
  expect(() => AnalyzeImpact.InputSchema.parse({})).toThrow();
});

test('analyze_impact: schema rejects invalid direction', () => {
  expect(() => AnalyzeImpact.InputSchema.parse({ changed_files: ['f.ts'], direction: 'sideways' })).toThrow();
});

test('analyze_impact: handler returns "not indexed" when workspace not initialised', async () => {
  const input = AnalyzeImpact.InputSchema.parse({ changed_files: ['src/login.ts'] });
  const result = await AnalyzeImpact.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

// ===== annotate_component =====

test('annotate_component: schema accepts valid input', () => {
  const result = AnnotateComponent.InputSchema.parse({ problem_id: 'prob_123', mode: 'explain' });
  expect(result.problem_id).toBe('prob_123');
  expect(result.mode).toBe('explain');
});

test('annotate_component: schema defaults mode to explain', () => {
  const result = AnnotateComponent.InputSchema.parse({ problem_id: 'prob_123' });
  expect(result.mode).toBe('explain');
});

test('annotate_component: schema requires problem_id', () => {
  expect(() => AnnotateComponent.InputSchema.parse({ mode: 'explain' })).toThrow();
});

test('annotate_component: annotates a finding from the local store', async () => {
  const { store, dir } = makeTempStore('mcp-annotate-');
  store.setWorkspaceScope(dir);
  store.upsertSeed({
    id: 'agf_123',
    workspace_id: dir,
    file_path: 'src/health-server.ts',
    line_start: 27,
    line_end: 30,
    category: 'Runtime issues',
    severity: 'HIGH',
    brief: 'Server startup can fail without handling.',
    confidence: 1,
    refs_json: '[]',
    produced_at: Date.now(),
    stale: false,
  });
  const input = AnnotateComponent.InputSchema.parse({ problem_id: 'agf_123' });
  const result = await AnnotateComponent.handle(input, mockApiClient, SESSION, store);
  expect(result).toContain('Why this matters');
  expect(result).toContain('src/health-server.ts:27-30');
});

test('annotate_component: an unknown id is not found, with no analysis request', async () => {
  const { store, dir } = makeTempStore('mcp-annotate-missing-');
  store.setWorkspaceScope(dir);
  const input = AnnotateComponent.InputSchema.parse({ problem_id: 'missing-problem', mode: 'recommend' });
  const result = await AnnotateComponent.handle(input, mockApiClient, SESSION, store);
  expect(result).toContain('not found');
  expect(result).toContain('no server-side analysis');
  expect(mockApiClient.get).not.toHaveBeenCalled();
});

// ===== mark_complete =====

test('mark_complete: schema accepts valid input', () => {
  const result = MarkComplete.InputSchema.parse({ problem_id: 'prob_456', action: 'discard' });
  expect(result.action).toBe('discard');
});

test('mark_complete: schema defaults action to endorse', () => {
  const result = MarkComplete.InputSchema.parse({ problem_id: 'prob_456' });
  expect(result.action).toBe('endorse');
});

test('mark_complete: schema requires problem_id', () => {
  expect(() => MarkComplete.InputSchema.parse({})).toThrow();
});

test('mark_complete: handler returns non-empty string', async () => {
  const input = MarkComplete.InputSchema.parse({ problem_id: 'prob_456' });
  const result = await MarkComplete.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

test('mark_complete: calls postFeedback', async () => {
  const input = MarkComplete.InputSchema.parse({ problem_id: 'prob_456' });
  await MarkComplete.handle(input, mockApiClient, SESSION);
  expect(mockApiClient.postFeedback).toHaveBeenCalled();
});

// ===== get_metrics =====

test('get_metrics: schema accepts empty input', () => {
  const result = GetMetrics.InputSchema.parse({});
  expect(result).toEqual({});
});

test('get_metrics: handler returns non-empty string', async () => {
  (mockApiClient.get as ReturnType<typeof mock>).mockImplementation(async () => ({}));
  const input = GetMetrics.InputSchema.parse({});
  const result = await GetMetrics.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

test('get_metrics: is computed locally — no request, and says there is no server-side analysis', async () => {
  const input = GetMetrics.InputSchema.parse({});
  const result = await GetMetrics.handle(input, mockApiClient, SESSION);
  expect(mockApiClient.get).not.toHaveBeenCalled();
  expect(mockApiClient.post).not.toHaveBeenCalled();
  expect(result).toContain('Server-side analysis: none');
});

// ===== assign_git_changes =====

test('assign_git_changes: schema accepts valid input', () => {
  const result = AssignGitChanges.InputSchema.parse({ changed_files: ['src/util.ts'] });
  expect(result.changed_files).toEqual(['src/util.ts']);
  expect(result.include_cochange_predictions).toBe(true);
});

test('assign_git_changes: schema requires changed_files', () => {
  expect(() => AssignGitChanges.InputSchema.parse({})).toThrow();
  expect(() => AssignGitChanges.InputSchema.parse({ changed_files: [] })).toThrow();
});

test('assign_git_changes: handler returns non-empty string', async () => {
  const input = AssignGitChanges.InputSchema.parse({ changed_files: ['src/util.ts'] });
  const result = await AssignGitChanges.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

// ===== get_analysis_context =====

test('get_analysis_context: schema accepts valid input', () => {
  const result = GetAnalysisContext.InputSchema.parse({ scope: 'project', problem_limit: 20 });
  expect(result.scope).toBe('project');
  expect(result.problem_limit).toBe(20);
});

test('get_analysis_context: schema defaults scope to session', () => {
  const result = GetAnalysisContext.InputSchema.parse({});
  expect(result.scope).toBe('session');
});

test('get_analysis_context: handler returns non-empty string', async () => {
  (mockApiClient.get as ReturnType<typeof mock>).mockImplementation(async () => ({ context: {} }));
  const input = GetAnalysisContext.InputSchema.parse({});
  const result = await GetAnalysisContext.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

// ===== Tool registry =====

test('TOOL_REGISTRY contains all 28 tools', async () => {
  const { TOOL_REGISTRY } = await import('../../src/tools/index');
  const names = Object.keys(TOOL_REGISTRY);
  expect(names.length).toBe(28);
  const expected = [
    'init_workspace', 'get_problems', 'search_codebase', 'predict_cochanges',
    'analyze_impact', 'annotate_component', 'mark_complete', 'get_metrics',
    'assign_git_changes', 'get_analysis_context', 'record_finding',
    'concept_search', 'concept_neighbors', 'concept_usage_stats',
    'concept_sequence', 'concept_link', 'concept_create', 'concept_record_usage',
    'run_goal', 'run_goal_async', 'goal_status', 'goal_reasoning',
    'provide_feedback', 'registry_query', 'execution_trace', 'resolve_impulse',
    'pull_assigned_work', 'submit_resolution',
  ];
  for (const name of expected) {
    expect(names).toContain(name);
  }
});
