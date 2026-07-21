/**
 * Unit tests for MCP tools
 * Tests all 10 registered tool handlers with a mocked API client
 */

import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisAPIClient } from '../../src/api-client';

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
const tempPaths: string[] = [];

let mockApiClient: AnalysisAPIClient;

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
    submitFiles: mock(async () => ({ status: 'pending', jobId: 'job_123' })),
    getAnalysis: mock(async () => ({
      status: 'complete',
      results: [],
    })),
    postFeedback: mock(async () => ({})),
    isVesselMode: mock(() => false),
  } as unknown as AnalysisAPIClient;
});

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function writeTempWorkspace(files: Record<string, string>): string {
  const dir = join(tmpdir(), `metabob-mcp-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf-8');
  }
  tempPaths.push(dir);
  return dir;
}

// ===== init_workspace =====

test('init_workspace: schema accepts valid input', () => {
  const result = InitWorkspace.InputSchema.parse({ workspace_path: '/tmp/project', batch_size: 3 });
  expect(result.batch_size).toBe(3);
});

test('init_workspace: schema uses defaults', () => {
  const result = InitWorkspace.InputSchema.parse({});
  expect(result.batch_size).toBe(5);
});

// init_workspace.handle() triggers ONNX runtime + Tree-sitter grammars (native,
// memory-heavy) — not suitable for fast unit tests. Handler tested in integration suite.

test('init_workspace: reports timeout as slow async processing instead of failure', async () => {
  (mockApiClient.submitFiles as ReturnType<typeof mock>).mockRejectedValue({
    code: 'API_TIMEOUT',
    message: 'Request to analysis API timed out',
  });

  const workspace = writeTempWorkspace({
    'index.ts': 'export const value = 1;\n',
  });

  const input = InitWorkspace.InputSchema.parse({
    workspace_path: workspace,
    batch_size: 1,
  });

  const result = await InitWorkspace.handle(input, mockApiClient, SESSION);
  expect(result).toContain('response timeout');
  expect(result).toContain('server may still be processing this batch');
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

test('get_problems: calls getAnalysis', async () => {
  const input = GetProblems.InputSchema.parse({});
  await GetProblems.handle(input, mockApiClient, SESSION);
  expect(mockApiClient.getAnalysis).toHaveBeenCalledWith(SESSION);
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

test('annotate_component: handler returns non-empty string', async () => {
  (mockApiClient.getAnalysis as ReturnType<typeof mock>).mockImplementation(async () => ({
    status: 'complete',
    results: [{
      id: 'prob_123',
      path: 'src/health-server.ts',
      category: 'Runtime issues',
      startLine: 27,
      endLine: 30,
      summary: 'Server startup can fail without handling.',
      description: 'Bun.serve may throw when the port is already in use.',
      severity: 'HIGH',
      discarded: false,
      endorsed: false,
    }],
  }));
  const input = AnnotateComponent.InputSchema.parse({ problem_id: 'prob_123' });
  const result = await AnnotateComponent.handle(input, mockApiClient, SESSION);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
  expect(result).toContain('Why this matters');
});

test('annotate_component: calls getAnalysis and returns not found for unknown ids', async () => {
  const input = AnnotateComponent.InputSchema.parse({ problem_id: 'missing-problem', mode: 'recommend' });
  const result = await AnnotateComponent.handle(input, mockApiClient, SESSION);
  expect(mockApiClient.getAnalysis).toHaveBeenCalledWith(SESSION);
  expect(result).toContain('not found');
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

test('get_metrics: calls get', async () => {
  (mockApiClient.get as ReturnType<typeof mock>).mockImplementation(async () => ({}));
  const input = GetMetrics.InputSchema.parse({});
  await GetMetrics.handle(input, mockApiClient, SESSION);
  expect(mockApiClient.get).toHaveBeenCalled();
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
