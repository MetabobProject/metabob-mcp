/**
 * Unit tests for MCP tools
 * Tests all tool handlers with mocked API client
 */

import { test, expect, mock, beforeEach } from 'bun:test';
import type { AnalysisAPIClient } from '../../src/api-client';

// Import all tool handlers
import * as GetPriorityIssues from '../../src/tools/get-priority-issues';
import * as SearchCodebase from '../../src/tools/search-codebase';
import * as AnnotateComponent from '../../src/tools/annotate-component';
import * as SuggestRelatedChanges from '../../src/tools/suggest-related-changes';
import * as AnalyzeChangeImpact from '../../src/tools/analyze-change-impact';
import * as MarkProblemComplete from '../../src/tools/mark-problem-complete';
import * as GenerateImplementationSpec from '../../src/tools/generate-implementation-spec';

// Mock API client
let mockApiClient: AnalysisAPIClient;
const TEST_SESSION_ID = 'test-session';

beforeEach(() => {
  mockApiClient = {
    get: mock(async () => ({})),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
  } as any;
});

// ===== get_priority_issues tests =====

test('get_priority_issues: returns formatted text with issues', async () => {
  mockApiClient.get = mock(async () => ({
    issues: [
      {
        id: 'prob_123',
        session_id: 'test-session',
        component_id: 'src/auth.ts::function::login::15',
        severity: 'HIGH',
        category: 'security',
        message: 'SQL injection vulnerability',
        impact_score: 0.95,
        status: 'open',
        created_at: '2026-03-24T12:00:00Z',
        updated_at: '2026-03-24T12:00:00Z',
      },
    ],
    total_issues: 1,
    query_time_ms: 10,
  }));

  const result = await GetPriorityIssues.handle(
    { limit: 10, scope: 'session' },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Found 1 priority issue');
  expect(result).toContain('[HIGH] security');
  expect(result).toContain('SQL injection vulnerability');
  expect(result).toContain('prob_123');
  expect(mockApiClient.get).toHaveBeenCalledWith(
    '/v2/analysis/priority',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('get_priority_issues: handles no issues', async () => {
  mockApiClient.get = mock(async () => ({
    issues: [],
    total_issues: 0,
    query_time_ms: 5,
  }));

  const result = await GetPriorityIssues.handle(
    { limit: 10, scope: 'session' },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('No priority issues found');
});

test('get_priority_issues: validates limit parameter', () => {
  expect(() => GetPriorityIssues.InputSchema.parse({ limit: -5 })).toThrow();
  expect(() => GetPriorityIssues.InputSchema.parse({ limit: 150 })).toThrow();
  expect(() => GetPriorityIssues.InputSchema.parse({ limit: 50 })).not.toThrow();
});

// ===== search_codebase tests =====

test('search_codebase: returns formatted search results', async () => {
  mockApiClient.post = mock(async () => ({
    results: [
      {
        id: 'problem:search-1',
        component_id: 'src/cache.ts::function::store::12',
        severity: 'CRITICAL',
        category: 'performance',
        message: 'Potential memory leak',
        similarity_score: 0.91,
      },
    ],
    total: 1,
    query: 'find memory leaks',
    query_time_ms: 38,
  }));

  const result = await SearchCodebase.handle(
    { query: 'find memory leaks', limit: 10 },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Search results for');
  expect(result).toContain('find memory leaks');
  expect(result).toContain('Potential memory leak');
  expect(result).toContain('91.0%');
  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/search',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('search_codebase: validates query parameter', () => {
  expect(() => SearchCodebase.InputSchema.parse({ query: '' })).toThrow();
  expect(() => SearchCodebase.InputSchema.parse({})).toThrow();
  expect(() => SearchCodebase.InputSchema.parse({ query: 'test' })).not.toThrow();
});

test('search_codebase: handles filters correctly', async () => {
  mockApiClient.post = mock(async () => ({
    results: [],
    total: 0,
    query: 'test',
    query_time_ms: 10,
  }));

  await SearchCodebase.handle(
    {
      query: 'test',
      limit: 5,
      filters: {
        severity: ['HIGH', 'CRITICAL'],
        category: ['security'],
        scope: 'project',
      },
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/search',
    expect.objectContaining({
      query: 'test',
      limit: 5,
      filters: expect.objectContaining({
        severity: ['HIGH', 'CRITICAL'],
        category: ['security'],
      }),
    }),
    TEST_SESSION_ID
  );
});

// ===== annotate_component tests =====

test('annotate_component: creates annotation successfully', async () => {
  mockApiClient.post = mock(async () => ({
    annotation_id: 'annotation:123',
    annotation: {
      id: 'annotation:123',
      component_id: 'src/auth.ts::function::login::15',
      text: 'Fixed SQL injection',
      type: 'bug_context',
      session_id: 'test-session',
      created_by: 'system',
      created_at: '2026-03-24T12:00:00Z',
    },
    query_time_ms: 5,
  }));

  const result = await AnnotateComponent.handle(
    {
      component_id: 'src/auth.ts::function::login::15',
      content: 'Fixed SQL injection',
      type: 'bug_context',
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Annotation created successfully');
  expect(result).toContain('annotation:123');
  expect(result).toContain('Fixed SQL injection');
  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/annotations',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('annotate_component: validates annotation type', () => {
  expect(() =>
    AnnotateComponent.InputSchema.parse({
      component_id: 'test',
      content: 'test',
      type: 'invalid_type',
    })
  ).toThrow();

  expect(() =>
    AnnotateComponent.InputSchema.parse({
      component_id: 'test',
      content: 'test',
      type: 'design_decision',
    })
  ).not.toThrow();
});

// ===== suggest_related_changes tests =====

test('suggest_related_changes: returns co-change suggestions', async () => {
  mockApiClient.post = mock(async () => ({
    suggestions: [
      {
        file_path: 'src/session.ts',
        confidence: 0.85,
        reason: 'semantic_similarity',
        affected_components: ['src/session.ts::function::createSession::8'],
        historical_frequency: 0,
        embedding_similarity: 0.85,
      },
    ],
    total: 1,
    changed_files: ['src/auth.ts'],
    config: {
      embedding_weight: 0.6,
      frequency_weight: 0.4,
      threshold: 0.3,
    },
    query_time_ms: 15,
  }));

  const result = await SuggestRelatedChanges.handle(
    {
      changed_files: ['src/auth.ts'],
      limit: 5,
      confidence_threshold: 0.3,
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Co-change suggestions for');
  expect(result).toContain('src/session.ts');
  expect(result).toContain('85.0%');
  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/cochange/suggest',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('suggest_related_changes: validates changed_files parameter', () => {
  expect(() =>
    SuggestRelatedChanges.InputSchema.parse({ changed_files: [] })
  ).toThrow();

  expect(() =>
    SuggestRelatedChanges.InputSchema.parse({ changed_files: ['src/test.ts'] })
  ).not.toThrow();
});

test('suggest_related_changes: handles custom config', async () => {
  mockApiClient.post = mock(async () => ({
    suggestions: [],
    total: 0,
    changed_files: ['src/test.ts'],
    config: { embedding_weight: 0.8, frequency_weight: 0.2, threshold: 0.5 },
    query_time_ms: 10,
  }));

  await SuggestRelatedChanges.handle(
    {
      changed_files: ['src/test.ts'],
      config: {
        embedding_weight: 0.8,
        frequency_weight: 0.2,
      },
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/cochange/suggest',
    expect.objectContaining({
      config: expect.objectContaining({
        embedding_weight: 0.8,
        frequency_weight: 0.2,
      }),
    }),
    TEST_SESSION_ID
  );
});

// ===== analyze_change_impact tests =====

test('analyze_change_impact: returns impact analysis', async () => {
  mockApiClient.post = mock(async () => ({
    analysis: {
      changed_components: ['src/auth.ts::function::main::1'],
      direct_dependencies: [
        {
          component_id: 'src/utils.ts::function::helper::10',
          component_name: 'helper',
          file_path: 'src/utils.ts',
          depth: 1,
          risk: 'high',
          reason: 'Direct dependency',
          annotations: [],
        },
      ],
      indirect_dependencies: [],
      affected_tests: [],
      risk_level: 'medium',
    },
    query_time_ms: 25,
  }));

  const result = await AnalyzeChangeImpact.handle(
    {
      changed_files: ['src/auth.ts'],
      direction: 'both',
      max_depth: 3,
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Impact Analysis');
  expect(result).toContain('src/auth.ts');
  expect(result).toContain('helper');
  expect(result).toContain('MEDIUM');
  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/impact',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('analyze_change_impact: validates direction parameter', () => {
  expect(() =>
    AnalyzeChangeImpact.InputSchema.parse({
      changed_files: ['test.ts'],
      direction: 'invalid',
    })
  ).toThrow();

  expect(() =>
    AnalyzeChangeImpact.InputSchema.parse({
      changed_files: ['test.ts'],
      direction: 'forward',
    })
  ).not.toThrow();
});

// ===== mark_problem_complete tests =====

test('mark_problem_complete: marks problem as resolved', async () => {
  mockApiClient.put = mock(async () => ({
    problem: {
      id: 'problem:sec-001',
      status: 'resolved',
      resolution_summary: 'Fixed SQL injection',
      fixed_in_commit: 'a1b2c3d',
      resolved_at: '2026-03-24T12:00:00Z',
      resolved_by: 'system',
    },
    annotation: {
      id: 'annotation:456',
      component_id: 'src/auth.ts::function::login::15',
      text: 'Fixed SQL injection',
      type: 'bug_context',
    },
  }));

  const result = await MarkProblemComplete.handle(
    {
      problem_id: 'problem:sec-001',
      resolution_summary: 'Fixed SQL injection',
      fixed_in_commit: 'a1b2c3d',
      create_annotation: true,
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Problem marked as complete');
  expect(result).toContain('problem:sec-001');
  expect(result).toContain('Fixed SQL injection');
  expect(result).toContain('a1b2c3d');
  expect(result).toContain('Annotation created');
  expect(mockApiClient.put).toHaveBeenCalledWith(
    '/v2/analysis/problems/problem:sec-001/complete',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('mark_problem_complete: validates required fields', () => {
  expect(() =>
    MarkProblemComplete.InputSchema.parse({
      problem_id: 'test',
    })
  ).toThrow();

  // Empty problem_id is actually allowed by the schema, but content must not be empty
  expect(() =>
    MarkProblemComplete.InputSchema.parse({
      problem_id: 'test',
      resolution_summary: '', // Empty string should fail
    })
  ).toThrow();

  expect(() =>
    MarkProblemComplete.InputSchema.parse({
      problem_id: 'test',
      resolution_summary: 'Fixed it',
    })
  ).not.toThrow();
});

// ===== generate_implementation_spec tests =====

test('generate_implementation_spec: generates spec', async () => {
  mockApiClient.post = mock(async () => ({
    spec_id: 'spec_789',
    goal: 'Add JWT authentication',
    overview: 'Implement JWT-based authentication system',
    steps: [
      {
        step_number: 1,
        title: 'Create JWT utility',
        description: 'Create utility functions for JWT operations',
        files_to_modify: [],
        files_to_create: ['src/utils/jwt.ts'],
        dependencies: [],
        estimated_complexity: 'low',
      },
    ],
    affected_components: ['src/auth.ts', 'src/middleware/auth.ts'],
    estimated_effort: '4-6 hours',
    risks: ['Token expiration handling', 'Secret key management'],
    created_at: '2026-03-24T12:00:00Z',
  }));

  const result = await GenerateImplementationSpec.handle(
    {
      goal: 'Add JWT authentication',
      entry_points: ['src/auth.ts'],
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  expect(result).toContain('Implementation Specification Generated');
  expect(result).toContain('spec_789');
  expect(result).toContain('Add JWT authentication');
  expect(result).toContain('Create JWT utility');
  expect(result).toContain('4-6 hours');
  expect(mockApiClient.post).toHaveBeenCalledWith(
    '/v2/analysis/specs/generate',
    expect.any(Object),
    TEST_SESSION_ID
  );
});

test('generate_implementation_spec: truncates large responses', async () => {
  // Create a large spec that exceeds 100KB
  const largeSteps = Array.from({ length: 1000 }, (_, i) => ({
    step_number: i + 1,
    title: `Step ${i + 1}`,
    description: 'A'.repeat(500),
    files_to_modify: [],
    files_to_create: [],
    dependencies: [],
    estimated_complexity: 'low' as const,
  }));

  mockApiClient.post = mock(async () => ({
    spec_id: 'spec_large',
    goal: 'Large goal',
    overview: 'Large overview',
    steps: largeSteps,
    affected_components: [],
    estimated_effort: '1 week',
    risks: [],
    created_at: '2026-03-24T12:00:00Z',
  }));

  const result = await GenerateImplementationSpec.handle(
    {
      goal: 'Large goal',
    },
    mockApiClient,
    TEST_SESSION_ID
  );

  const byteSize = Buffer.byteLength(result, 'utf8');
  expect(byteSize).toBeLessThanOrEqual(100 * 1024 + 500); // Allow some overhead for warning
  expect(result).toContain('RESPONSE TRUNCATED');
});

test('generate_implementation_spec: validates goal parameter', () => {
  expect(() =>
    GenerateImplementationSpec.InputSchema.parse({ goal: '' })
  ).toThrow();

  expect(() =>
    GenerateImplementationSpec.InputSchema.parse({})
  ).toThrow();

  expect(() =>
    GenerateImplementationSpec.InputSchema.parse({ goal: 'Add feature' })
  ).not.toThrow();
});

// ===== Tool registry tests =====

test('all tools are properly registered in registry', () => {
  const { TOOL_REGISTRY } = require('../../src/tools/index');

  const expectedTools = [
    'get_priority_issues',
    'search_codebase',
    'annotate_component',
    'suggest_related_changes',
    'analyze_change_impact',
    'mark_problem_complete',
    'generate_implementation_spec',
  ];

  const registeredTools = Object.keys(TOOL_REGISTRY);

  for (const toolName of expectedTools) {
    expect(registeredTools).toContain(toolName);
    expect(TOOL_REGISTRY[toolName]).toHaveProperty('name');
    expect(TOOL_REGISTRY[toolName]).toHaveProperty('description');
    expect(TOOL_REGISTRY[toolName]).toHaveProperty('inputSchema');
    expect(TOOL_REGISTRY[toolName]).toHaveProperty('handler');
    expect(TOOL_REGISTRY[toolName]).toHaveProperty('validateInput');
  }

  expect(registeredTools.length).toBe(7);
});
