# Required Fixes for metabob-mcp

## Summary

3 MCP tools need endpoint updates to match the deployed API contract.
1 tool should be removed until the API implements the endpoint.

Total estimated time: **2-3 hours**

---

## Fix 1: annotate_component Tool

**File:** `src/tools/annotate-component.ts`

### Current Implementation (BROKEN)
```typescript
// Line 74-84
const result: AnnotateComponentOutput = await apiClient.post(
  '/v2/analysis/components/:id/annotate',  // ❌ 404 error
  {
    component_id: input.component_id,
    annotation_type: input.type,            // ❌ Wrong field name
    annotation_value: input.content,        // ❌ Wrong field name
    tags: input.tags,
    link_to_problem_id: input.link_to_problem_id,
  },
  sessionId
);
```

### Fixed Implementation
```typescript
// Line 74-84
const result: AnnotateComponentOutput = await apiClient.post(
  '/v2/analysis/annotations',              // ✓ Correct endpoint
  {
    component_id: input.component_id,
    content: input.content,                 // ✓ Correct field name
    type: input.type,                       // ✓ Correct field name
    tags: input.tags,
    link_to_problem_id: input.link_to_problem_id,
  },
  sessionId
);
```

### Changes Required
1. Line 74: Change endpoint from `/v2/analysis/components/:id/annotate` to `/v2/analysis/annotations`
2. Line 78: Remove `annotation_type` field (moved to line 79)
3. Line 79: Change from `annotation_value: input.content` to `type: input.type`
4. Line 80: Add `content: input.content` (or move existing line)

---

## Fix 2: suggest_related_changes Tool

**File:** `src/tools/suggest-related-changes.ts`

### Current Implementation (BROKEN)
```typescript
// Input schema (lines 14-49)
inputSchema: {
  type: 'object',
  properties: {
    component_id: {               // ❌ API doesn't use this
      type: 'string',
      description: 'Component ID from search',
    },
    change_description: {         // ❌ API doesn't use this
      type: 'string',
      description: 'Description of the change',
    },
    limit: {
      type: 'number',
      default: 5,
    },
  },
  required: ['component_id', 'change_description'],
}

// Handler (line 86-95)
const result = await apiClient.post(
  '/v2/analysis/components/:id/related-changes',  // ❌ 404 error
  {
    component_id: input.component_id,
    change_description: input.change_description,
    limit: input.limit,
  },
  sessionId
);
```

### Fixed Implementation
```typescript
// Input schema (lines 14-49)
inputSchema: {
  type: 'object',
  properties: {
    changed_files: {              // ✓ API expects array of files
      type: 'array',
      description: 'List of file paths that are being changed',
      items: { type: 'string' },
    },
    limit: {
      type: 'number',
      description: 'Maximum number of suggestions to return (default: 5)',
      default: 5,
    },
    confidence_threshold: {       // ✓ API expects threshold
      type: 'number',
      description: 'Minimum confidence score (0.0 to 1.0, default: 0.3)',
      default: 0.3,
    },
    config: {                     // ✓ Optional hybrid scoring config
      type: 'object',
      properties: {
        embedding_weight: { type: 'number', default: 0.6 },
        frequency_weight: { type: 'number', default: 0.4 },
      },
    },
  },
  required: ['changed_files'],
}

// Handler (line 86-95)
const result = await apiClient.post(
  '/v2/analysis/cochange/suggest',  // ✓ Correct endpoint
  {
    changed_files: input.changed_files,
    limit: input.limit,
    confidence_threshold: input.confidence_threshold,
    config: input.config,
  },
  sessionId
);
```

### Changes Required
1. **Input Schema (lines 14-49):** Complete rewrite
   - Remove `component_id` property
   - Remove `change_description` property
   - Add `changed_files: array` property
   - Add `confidence_threshold: number` property
   - Add `config: object` property
   - Update `required` array to `['changed_files']`

2. **Zod Schema (lines 51-61):** Update to match
   ```typescript
   export const InputSchema = z.object({
     changed_files: z.array(z.string()).min(1),
     limit: z.number().int().positive().max(50).default(5),
     confidence_threshold: z.number().min(0).max(1).default(0.3),
     config: z.object({
       embedding_weight: z.number().min(0).max(1).default(0.6),
       frequency_weight: z.number().min(0).max(1).default(0.4),
     }).optional(),
   });
   ```

3. **Output Interface (lines 65-76):** Already correct, keep as-is

4. **Handler (lines 86-95):** Update endpoint and body
   - Line 86: Change to `/v2/analysis/cochange/suggest`
   - Lines 88-92: Update body to match new schema

5. **Format Function (lines 103-155):** Update parameter
   - Line 104: Change from `component_id` to `changedFiles: string[]`
   - Line 110-113: Update output text formatting

---

## Fix 3: analyze_change_impact Tool

**File:** `src/tools/analyze-change-impact.ts`

### Current Implementation (BROKEN)
```typescript
// Input schema (lines 14-42)
inputSchema: {
  type: 'object',
  properties: {
    component_id: {               // ❌ API doesn't use this
      type: 'string',
      description: 'Component ID',
    },
    change_type: {                // ❌ API doesn't use this
      type: 'string',
      description: 'Type of change',
      enum: ['interface_change', 'implementation', 'refactor'],
    },
  },
  required: ['component_id', 'change_type'],
}

// Handler (line 84-92)
const result = await apiClient.post(
  '/v2/analysis/components/:id/impact',  // ❌ 404 error
  {
    component_id: input.component_id,
    change_type: input.change_type,
  },
  sessionId
);
```

### Fixed Implementation
```typescript
// Input schema (lines 14-42)
inputSchema: {
  type: 'object',
  properties: {
    changed_files: {              // ✓ API expects array of files
      type: 'array',
      description: 'List of file paths being changed',
      items: { type: 'string' },
    },
    diff: {                       // ✓ Optional git diff
      type: 'string',
      description: 'Optional: Git diff output for more precise analysis',
    },
    direction: {                  // ✓ Traversal direction
      type: 'string',
      description: 'Traverse direction (forward = dependencies, backward = dependents, both = both directions)',
      enum: ['forward', 'backward', 'both'],
      default: 'both',
    },
    max_depth: {                  // ✓ Graph depth
      type: 'number',
      description: 'Maximum traversal depth (default: 5)',
      default: 5,
    },
    include_tests: {              // ✓ Include test files
      type: 'boolean',
      description: 'Include test files in analysis (default: true)',
      default: true,
    },
  },
  required: ['changed_files'],
}

// Handler (line 84-92)
const result = await apiClient.post(
  '/v2/analysis/impact',          // ✓ Correct endpoint
  {
    changed_files: input.changed_files,
    diff: input.diff,
    direction: input.direction,
    max_depth: input.max_depth,
    include_tests: input.include_tests,
  },
  sessionId
);
```

### Changes Required
1. **Tool Definition (lines 9-42):** Complete rewrite
   - Remove `component_id` property
   - Remove `change_type` property
   - Add `changed_files: array` property
   - Add `diff: string` property (optional)
   - Add `direction: enum` property
   - Add `max_depth: number` property
   - Add `include_tests: boolean` property
   - Update `required` array to `['changed_files']`

2. **Zod Schema (lines 45-51):** Update to match
   ```typescript
   export const InputSchema = z.object({
     changed_files: z.array(z.string()).min(1),
     diff: z.string().optional(),
     direction: z.enum(['forward', 'backward', 'both']).default('both'),
     max_depth: z.number().int().positive().max(10).default(5),
     include_tests: z.boolean().default(true),
   });
   ```

3. **Handler (lines 84-92):** Update endpoint and body
   - Line 84: Change to `/v2/analysis/impact`
   - Lines 86-91: Update body to match new schema

4. **Format Function (lines 102-198):** Update parameter
   - Already takes `changedFiles: string[]` - no changes needed

---

## Fix 4: Remove generate_implementation_spec Tool

**File:** `src/tools/index.ts`

### Current Implementation (BROKEN)
```typescript
export const TOOL_REGISTRY: Record<string, Tool> = {
  get_priority_issues: { ... },
  search_codebase: { ... },
  annotate_component: { ... },
  suggest_related_changes: { ... },
  analyze_change_impact: { ... },
  mark_problem_complete: { ... },
  generate_implementation_spec: {  // ❌ API doesn't implement this
    ...GenerateImplementationSpec.GenerateImplementationSpecTool,
    handler: GenerateImplementationSpec.handle,
    validateInput: (input: any) => GenerateImplementationSpec.InputSchema.parse(input),
  },
};
```

### Fixed Implementation
```typescript
export const TOOL_REGISTRY: Record<string, Tool> = {
  get_priority_issues: { ... },
  search_codebase: { ... },
  annotate_component: { ... },
  suggest_related_changes: { ... },
  analyze_change_impact: { ... },
  mark_problem_complete: { ... },
  // generate_implementation_spec: Commented out until API implements endpoint
  // {
  //   ...GenerateImplementationSpec.GenerateImplementationSpecTool,
  //   handler: GenerateImplementationSpec.handle,
  //   validateInput: (input: any) => GenerateImplementationSpec.InputSchema.parse(input),
  // },
};
```

### Changes Required
1. **Lines 47-51:** Comment out or delete the entire entry
2. **Line 1:** Remove import if not used elsewhere
   ```typescript
   // import * as GenerateImplementationSpec from './generate-implementation-spec.js';
   ```

### Alternative: Keep but add warning
If you want to keep the tool but warn users:

```typescript
export const TOOL_REGISTRY: Record<string, Tool> = {
  // ... other tools ...
  generate_implementation_spec: {
    ...GenerateImplementationSpec.GenerateImplementationSpecTool,
    description: '[NOT IMPLEMENTED] ' + GenerateImplementationSpec.GenerateImplementationSpecTool.description,
    handler: async (input, apiClient, sessionId) => {
      throw new Error('generate_implementation_spec is not yet implemented by the API. Coming soon.');
    },
    validateInput: (input: any) => GenerateImplementationSpec.InputSchema.parse(input),
  },
};
```

---

## Testing After Fixes

### 1. Run Direct API Tests
```bash
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-mcp
bun run test-api-direct.ts
```

**Expected Output:**
```
Passed: 6/7 (or 7/7 if annotate/cochange/impact all work)

✓ Health Check
✓ Get Priority Issues
✓ Search Codebase
✓ Annotate Component
✓ Suggest Related Changes
✓ Analyze Change Impact
✓ Mark Problem Complete
✗ Generate Implementation Spec (removed)
```

### 2. Test MCP Protocol
```bash
# Start server with port-forward
kubectl port-forward -n activity-system svc/metabob-analysis-api 9083:8080 &

# Run MCP server
ANALYSIS_API_URL="http://localhost:9083" \
SESSION_ID="test-$(date +%s)" \
LOG_LEVEL="debug" \
HEALTH_PORT="8092" \
bun run src/index.ts
```

Test with MCP client or send JSON-RPC manually:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}

{"jsonrpc":"2.0","id":2,"method":"tools/list"}

{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_priority_issues","arguments":{"limit":5}}}
```

### 3. Integration Test
Create a test file:

```typescript
// test-integration.ts
import { test, expect } from 'bun:test';

test('annotate_component works', async () => {
  const response = await fetch('http://localhost:9083/v2/analysis/annotations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': 'test-session',
    },
    body: JSON.stringify({
      component_id: 'src/test.ts::function::main::1',
      content: 'Test annotation',
      type: 'design_decision',
    }),
  });

  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.annotation_id).toBeDefined();
});

// Add tests for other tools...
```

---

## Verification Checklist

After applying all fixes:

- [ ] Fix 1 applied: annotate_component endpoint updated
- [ ] Fix 2 applied: suggest_related_changes endpoint updated
- [ ] Fix 3 applied: analyze_change_impact endpoint updated
- [ ] Fix 4 applied: generate_implementation_spec removed/commented
- [ ] TypeScript compiles without errors: `bun run typecheck`
- [ ] Direct API tests pass: `bun run test-api-direct.ts`
- [ ] MCP server starts successfully
- [ ] tools/list returns 6 tools (or 7 if keeping spec with warning)
- [ ] Each tool can be called without 404 errors
- [ ] Documentation updated to reflect changes

---

## Timeline

- **Fix 1:** 20 minutes
- **Fix 2:** 45 minutes (more complex schema changes)
- **Fix 3:** 45 minutes (more complex schema changes)
- **Fix 4:** 5 minutes
- **Testing:** 30 minutes
- **Total:** ~2.5 hours

---

## Questions?

If you encounter issues:

1. Check the port-forward is still running: `ps aux | grep port-forward`
2. Verify API is healthy: `curl http://localhost:9083/health`
3. Check MCP server logs in stderr
4. Test endpoints directly with curl before testing through MCP
5. Verify TypeScript types match the new schemas

---

## Next Steps After Fixes

1. Add contract tests to CI/CD
2. Create OpenAPI spec for API documentation
3. Consider implementing generate_implementation_spec endpoint
4. Test with real codebase data once CPG is populated
5. Deploy to staging/production
6. Update user documentation with correct examples
