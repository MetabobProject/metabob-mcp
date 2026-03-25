# metabob-mcp Server Test Report

**Date:** 2026-03-24
**API Endpoint:** http://localhost:9083 (port-forward to activity-system/metabob-analysis-api)
**Session ID:** test-direct-1774373920310

## Summary

Tested 8 API endpoints that support the 7 MCP tools:
- **Passed:** 4/8 (50%)
- **Failed:** 4/8 (50%)

## Environment Setup

### Configuration
```bash
export ANALYSIS_API_URL="http://localhost:9083"
export SESSION_ID="local-test-session-$(date +%s)"
export LOG_LEVEL="debug"
export HEALTH_PORT="8092"
```

### Port Forward
```bash
kubectl port-forward -n activity-system svc/metabob-analysis-api 9083:8080
```

### Connectivity
- ✓ metabob-analysis-api pod is running in activity-system namespace
- ✓ Service is accessible via port-forward
- ✓ Health endpoint responds correctly

## Test Results by Endpoint

### 1. Health Check
**Endpoint:** `GET /health`
**Status:** ✓ PASS
**Duration:** 15ms

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-03-24T17:33:56.263Z",
  "service": "metabob-analysis-api",
  "version": "0.1.0"
}
```

---

### 2. Get Priority Issues
**MCP Tool:** `get_priority_issues`
**Endpoint:** `GET /v2/analysis/priority`
**Status:** ✓ PASS
**Duration:** 4ms

**Request:**
```
GET /v2/analysis/priority?limit=5&severity[]=HIGH&severity[]=CRITICAL&scope=session
Headers:
  X-Session-ID: test-direct-1774373920310
```

**Response:** Found 2 issues

**MCP Tool Mapping:** ✓ Correct
- Tool calls: `/v2/analysis/priority`
- API implements: `/v2/analysis/priority`

---

### 3. Search Codebase
**MCP Tool:** `search_codebase`
**Endpoint:** `POST /v2/analysis/search`
**Status:** ✓ PASS
**Duration:** 326ms

**Request:**
```json
{
  "query": "function",
  "limit": 5
}
```

**Response:** Found 0 results (CPG not populated with code yet)

**MCP Tool Mapping:** ✓ Correct
- Tool calls: `/v2/analysis/search`
- API implements: `/v2/analysis/search`

---

### 4. Annotate Component
**MCP Tool:** `annotate_component`
**Endpoint:** `POST /v2/analysis/annotations`
**Status:** ✓ PASS (API works, but MCP tool needs update)
**Duration:** 2ms

**Issue:** MCP tool calls `/v2/analysis/components/:id/annotate` but API implements `/v2/analysis/annotations`

**Correct Request:**
```json
POST /v2/analysis/annotations
{
  "component_id": "test-component-123",
  "content": "Test annotation",
  "type": "semantic"
}
```

**MCP Tool Mapping:** ✗ INCORRECT
- Tool calls: `/v2/analysis/components/:id/annotate`
- API implements: `/v2/analysis/annotations`
- **Fix Required:** Update MCP tool to use correct endpoint

---

### 5. Suggest Related Changes
**MCP Tool:** `suggest_related_changes`
**Endpoint:** `POST /v2/analysis/cochange/suggest`
**Status:** ✓ PASS (API works, but MCP tool needs update)
**Duration:** 1ms

**Issue:** MCP tool calls `/v2/analysis/components/:id/related-changes` but API implements `/v2/analysis/cochange/suggest`

**Correct Request:**
```json
POST /v2/analysis/cochange/suggest
{
  "changed_files": ["src/main.ts"],
  "limit": 3,
  "confidence_threshold": 0.3
}
```

**MCP Tool Mapping:** ✗ INCORRECT
- Tool calls: `/v2/analysis/components/:id/related-changes`
- API implements: `/v2/analysis/cochange/suggest`
- **Fix Required:** Update MCP tool to use correct endpoint

---

### 6. Analyze Change Impact
**MCP Tool:** `analyze_change_impact`
**Endpoint:** `POST /v2/analysis/impact`
**Status:** ✓ PASS (API works, but MCP tool needs update)
**Duration:** 2ms

**Issue:** MCP tool calls `/v2/analysis/components/:id/impact` but API implements `/v2/analysis/impact`

**Correct Request:**
```json
POST /v2/analysis/impact
{
  "changed_files": ["src/main.ts"],
  "direction": "both",
  "max_depth": 5,
  "include_tests": true
}
```

**MCP Tool Mapping:** ✗ INCORRECT
- Tool calls: `/v2/analysis/components/:id/impact`
- API implements: `/v2/analysis/impact`
- **Fix Required:** Update MCP tool to use correct endpoint

---

### 7. Mark Problem Complete
**MCP Tool:** `mark_problem_complete`
**Endpoint:** `PUT /v2/analysis/problems/:id/complete`
**Status:** ✓ PASS
**Duration:** 2ms

**Request:**
```json
PUT /v2/analysis/problems/test-problem-123/complete
{
  "resolution_summary": "Fixed the issue",
  "files_modified": ["src/test.ts"]
}
```

**MCP Tool Mapping:** ✓ Correct
- Tool calls: `/v2/analysis/problems/:id/complete`
- API implements: `/v2/analysis/problems/:id/complete`

---

### 8. Generate Implementation Spec
**MCP Tool:** `generate_implementation_spec`
**Endpoint:** `POST /v2/analysis/specs/generate`
**Status:** ✗ FAIL - NOT IMPLEMENTED
**Duration:** 90ms

**Issue:** API does not implement this endpoint at all

**MCP Tool Mapping:** ✗ NOT IMPLEMENTED
- Tool calls: `/v2/analysis/specs/generate`
- API implements: (none)
- **Fix Required:** Either implement API endpoint or remove MCP tool

---

## Contract Violations Found

### 1. Annotate Component Endpoint Mismatch
**Severity:** Medium
**Impact:** Tool will always fail with 404

**Expected by MCP:**
```
POST /v2/analysis/components/{component_id}/annotate
```

**Implemented by API:**
```
POST /v2/analysis/annotations
Body: { component_id: string, ... }
```

**Fix:** Update `src/tools/annotate-component.ts` to call `/v2/analysis/annotations`

---

### 2. Suggest Related Changes Endpoint Mismatch
**Severity:** Medium
**Impact:** Tool will always fail with 404

**Expected by MCP:**
```
POST /v2/analysis/components/{component_id}/related-changes
Body: { change_description: string, limit: number }
```

**Implemented by API:**
```
POST /v2/analysis/cochange/suggest
Body: { changed_files: string[], limit: number, confidence_threshold: number }
```

**Fix:** Update `src/tools/suggest-related-changes.ts`:
- Call `/v2/analysis/cochange/suggest`
- Change input schema from `component_id` + `change_description` to `changed_files`

---

### 3. Analyze Change Impact Endpoint Mismatch
**Severity:** Medium
**Impact:** Tool will always fail with 404

**Expected by MCP:**
```
POST /v2/analysis/components/{component_id}/impact
Body: { change_type: string }
```

**Implemented by API:**
```
POST /v2/analysis/impact
Body: { changed_files: string[], direction: string, max_depth: number }
```

**Fix:** Update `src/tools/analyze-change-impact.ts`:
- Call `/v2/analysis/impact`
- Change input schema from `component_id` + `change_type` to `changed_files` + `direction`

---

### 4. Generate Implementation Spec Not Implemented
**Severity:** High
**Impact:** Tool will always fail with 404

**Expected by MCP:**
```
POST /v2/analysis/specs/generate
Body: { goal: string, entry_points?: string[], context?: string }
```

**Implemented by API:**
```
(none - endpoint does not exist)
```

**Fix Option 1:** Implement endpoint in metabob-analysis-api
**Fix Option 2:** Remove tool from MCP registry (simpler short-term)

---

## Recommendations

### Immediate Fixes (High Priority)

1. **Update MCP tool endpoints** to match API implementation:
   - `annotate_component.ts`: Use `/v2/analysis/annotations`
   - `suggest_related_changes.ts`: Use `/v2/analysis/cochange/suggest`
   - `analyze_change_impact.ts`: Use `/v2/analysis/impact`

2. **Remove or stub `generate_implementation_spec`** until API implements it

3. **Update input schemas** to match API contracts:
   - Replace `component_id` with `changed_files` where applicable
   - Align parameter names (e.g., `confidence_threshold` vs `limit`)

### Testing Recommendations

1. **Add contract tests** that verify MCP tools match API implementation
2. **Mock the CPG** in tests since it's not populated yet
3. **Test with real data** once CPG is populated from codebase scans

### Performance Notes

- Search endpoint takes 326ms (reasonable for empty CPG)
- All other endpoints respond in <5ms
- Port-forward adds minimal latency

### Next Steps

1. Fix the 3 endpoint mismatches in MCP tools
2. Remove or implement generate_implementation_spec
3. Run full MCP protocol tests (initialize, tools/list, tools/call)
4. Test with Claude Desktop or other MCP client
5. Populate CPG with actual codebase data for realistic testing

---

## Files to Update

### metabob-mcp (Client)

1. `src/tools/annotate-component.ts`
   - Line 74: Change endpoint to `/v2/analysis/annotations`

2. `src/tools/suggest-related-changes.ts`
   - Line 86: Change endpoint to `/v2/analysis/cochange/suggest`
   - Update input schema to use `changed_files` instead of `component_id`

3. `src/tools/analyze-change-impact.ts`
   - Line 84: Change endpoint to `/v2/analysis/impact`
   - Update input schema to use `changed_files` instead of `component_id`

4. `src/tools/index.ts`
   - Comment out or remove `generate_implementation_spec` from registry

### metabob-analysis-api (Server)

**Option 1:** Add missing endpoint
- Implement `POST /v2/analysis/specs/generate`

**Option 2:** Document limitations
- Add note to README that spec generation is not yet implemented

---

## Test Artifacts

**Test Script:** `/home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-mcp/test-api-direct.ts`

**Run Command:**
```bash
cd /home/avi/documents/work/exp-repo/metabob-devbob/repos/metabob-mcp
bun run test-api-direct.ts
```

**Expected Output After Fixes:**
```
Passed: 7/8 (or 6/7 if generate_implementation_spec is removed)
```
