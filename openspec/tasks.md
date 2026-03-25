# Metabob MCP - Implementation Tasks

**Repo:** repos/metabob-mcp
**Owner:** mcp-agent
**Status:** Draft

---

## Overview

MCP server exposing 7 analysis tools to AI agents (Claude, Cursor, etc.). Wraps HTTP API from metabob-analysis-api.

**Dependencies:**
- `http-api-v2-analysis` (1.0.0) - Backend API from repos/metabob-analysis-api

**Provides:**
- `mcp-analysis-tools` contract (version 1.0.0)

**Estimated Total:** 6 tasks, ~31 hours

---

## Phase 1: MCP Server (Week 7)

### MCP-1: Project Setup
**Depends On:** None
**Estimate:** 2 hours

**Description:**
Set up TypeScript/Bun project with MCP SDK.

**Acceptance Criteria:**
- [ ] `package.json` includes `@modelcontextprotocol/sdk`
- [ ] `tsconfig.json` configured
- [ ] `src/index.ts` with basic MCP server
- [ ] `bun run start` launches MCP server
- [ ] MCP initialization successful

**Ripple Check:**
- [ ] None (initial setup)

---

### MCP-2: API Client
**Depends On:** MCP-1
**Estimate:** 4 hours

**Description:**
HTTP client for communicating with metabob-analysis-api.

**Acceptance Criteria:**
- [ ] `src/api-client.ts` created with `AnalysisAPIClient` class
- [ ] `post<T>(endpoint, body)`: HTTP POST with JSON
- [ ] `get<T>(endpoint, params)`: HTTP GET with query params
- [ ] Error handling: Transform API errors to MCP errors
- [ ] Timeout: 30s default, configurable
- [ ] Retry logic: 3 attempts with exponential backoff
- [ ] Unit tests with mocked fetch

**Error Transformation:**
```typescript
async handleError(error: unknown): Promise<MCPError> {
  if (error instanceof APIError) {
    const errorMap: Record<string, MCPError> = {
      'SESSION_NOT_FOUND': {
        code: 'SESSION_EXPIRED',
        message: 'Session token is invalid or expired',
        suggestion: 'Please re-authenticate'
      },
      'COMPONENT_NOT_FOUND': {
        code: 'COMPONENT_NOT_FOUND',
        message: error.message,
        details: error.details,
        suggestion: 'Run search_codebase_issues to find valid component IDs'
      }
    };
    return errorMap[error.code] || defaultError;
  }
  return { code: 'INTERNAL_ERROR', message: 'Unexpected error occurred' };
}
```

**Ripple Check:**
- [ ] Verify API client matches http-api-v2-analysis contract

---

### MCP-3: Session Manager
**Depends On:** MCP-1
**Estimate:** 3 hours

**Description:**
Manage MCP session context and scope resolution.

**Acceptance Criteria:**
- [ ] `src/session-manager.ts` created with `SessionManager` class
- [ ] `getSession(sessionId)`: Retrieve or create session context
- [ ] `resolveScope(sessionId, scope)`: Map "session"/"project"/"org" to IDs
- [ ] `trackUsage(sessionId, tool, latency)`: Record tool call metrics
- [ ] Session caching (in-memory, 1-hour expiry)
- [ ] Unit tests

**Ripple Check:**
- [ ] None (internal session management)

---

### MCP-4: Tool Implementations (Part 1: Core)
**Depends On:** MCP-2, MCP-3
**Estimate:** 8 hours

**Description:**
Implement first 4 MCP tools.

**Acceptance Criteria:**
- [ ] `src/tools/get-priority-issues.ts`: Map MCP params → API POST /v2/analysis/priority
- [ ] `src/tools/search-codebase.ts`: Map MCP params → API POST /v2/analysis/search
- [ ] `src/tools/annotate-component.ts`: Map MCP params → API POST /v2/analysis/annotations
- [ ] `src/tools/mark-complete.ts`: Map MCP params → API PUT /v2/analysis/problems/:id/complete
- [ ] Each tool handles errors and returns consistent MCP format
- [ ] `src/tools/index.ts` exports tool registry
- [ ] Unit tests for each tool

**Tool Structure:**
```typescript
// src/tools/get-priority-issues.ts
export async function getPriorityIssues(
  params: GetPriorityIssuesParams,
  context: MCPContext
): Promise<GetPriorityIssuesResult> {
  const apiClient = context.apiClient;
  const sessionId = await context.sessionManager.getSession(context.sessionId);

  try {
    const response = await apiClient.post<APIResponse>('/v2/analysis/priority', {
      ...params,
      session_id: sessionId
    });

    return transformToMCPFormat(response);
  } catch (error) {
    throw await apiClient.handleError(error);
  }
}
```

**Reference:** `openspec/contracts/mcp-analysis-tools.md`

**Ripple Check:**
- [ ] Verify tools match mcp-analysis-tools contract exactly

---

### MCP-5: Tool Implementations (Part 2: Advanced)
**Depends On:** MCP-4
**Estimate:** 8 hours

**Description:**
Implement remaining 3 MCP tools.

**Acceptance Criteria:**
- [ ] `src/tools/suggest-changes.ts`: Map MCP params → API POST /v2/analysis/cochange/suggest
- [ ] `src/tools/analyze-impact.ts`: Map MCP params → API POST /v2/analysis/impact
- [ ] `src/tools/generate-spec.ts`: Map MCP params → API POST /v2/analysis/specs/generate
- [ ] Error handling for large responses (spec generation can be big)
- [ ] Streaming support for generate-spec (if response >100KB)
- [ ] Unit tests

**Reference:** `openspec/contracts/mcp-analysis-tools.md`

**Ripple Check:**
- [ ] Verify tools match mcp-analysis-tools contract exactly

---

### MCP-6: Integration Tests
**Depends On:** MCP-5
**Estimate:** 6 hours

**Description:**
End-to-end MCP → API → Database flow tests.

**Acceptance Criteria:**
- [ ] `tests/integration/tool-flow.test.ts` created
- [ ] Test: Initialize MCP server → Call all 7 tools → Verify responses
- [ ] Test: Error handling (invalid session, component not found, etc.)
- [ ] Test: Rate limiting (exceed 60 req/min)
- [ ] Test: Session scope resolution
- [ ] All tests pass
- [ ] Coverage >80%

**Test Example:**
```typescript
test('end-to-end: get priority issues', async () => {
  // Setup: Seed database with test data
  const sessionId = await seedTestSession();

  // Execute: Call MCP tool
  const result = await mcpServer.callTool('get_priority_issues', {
    limit: 5,
    severity: ['HIGH'],
    scope: 'session'
  });

  // Verify: Check response format and content
  expect(result.issues).toHaveLength(5);
  expect(result.issues[0].severity).toBe('HIGH');
  expect(result.issues[0].priority_rank).toBe(1);
});
```

**Ripple Check:**
- [ ] None (internal tests)

---

## Completion Checklist

Before marking this repo complete:

- [ ] All 6 tasks completed
- [ ] All 7 tools implemented
- [ ] Tools match mcp-analysis-tools contract exactly
- [ ] Test coverage >80%
- [ ] MCP server starts without errors
- [ ] Can connect from AI agent (Claude, Cursor)

**Ripple to Other Repos:**
- [ ] Notify **metabob-cloud-dashboard** - MCP tools available
- [ ] Update **e2e-tests** contract - Add MCP tool validation scenarios

---

## Notes

**MCP Protocol:**
- Use stdio transport for local development
- Support both Claude and Cursor
- Handle tool call timeouts gracefully

**Error Handling:**
- Transform API errors to user-friendly MCP errors
- Include suggestions in error messages
- Log errors for debugging

**Performance:**
- Keep tool call overhead minimal
- Cache session data
- Implement request deduplication if needed
