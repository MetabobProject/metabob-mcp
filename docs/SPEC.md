# metabob-mcp — Tool Specification

## Overview

`metabob-mcp` is the canonical MCP (Model Context Protocol) bridge between AI agents and Metabob's code analysis capabilities. It replaces `metabob-cli` as the agent-facing interface and is the single package any agent (Claude Code, Cursor, Continue, custom) should use to interact with Metabob.

The server has two execution tiers:

| Tier | Description | Requires |
|------|-------------|----------|
| **Local** | Runs entirely in-process using embedded `cpg-inference-ts` | Workspace files |
| **API** | Calls the Metabob Analysis API for server-side results | API key + running server |

Tools declare which tier they use. Some tools use both (local CPG for traversal, API for persisted results).

---

## Architecture

```
Agent (Claude Code / Cursor / custom)
        │  MCP over stdio (JSON-RPC 2.0)
        ▼
┌──────────────────────────────────────────────┐
│              metabob-mcp server               │
│                                               │
│  ┌─────────────────┐  ┌────────────────────┐ │
│  │  Tool Registry  │  │  Session Manager   │ │
│  └────────┬────────┘  └────────────────────┘ │
│           │                                   │
│  ┌────────▼────────────────────────────────┐ │
│  │            Tool Handlers                │ │
│  │  Local tier      │  API tier            │ │
│  │  ─────────────   │  ─────────────────   │ │
│  │  cpg-inference-ts│  AnalysisAPIClient   │ │
│  │  (in-process)    │  (HTTP, JWT auth)    │ │
│  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
        │                       │
        ▼                       ▼
  Local workspace          Analysis API
  (Tree-sitter parse,      (localhost:8081 or
   GCN embeddings,          configured URL)
   vector index)
```

### cpg-inference-ts integration

`cpg-inference-ts` (`@metabob/cpg-inference`) is vendored into `metabob-mcp` as a workspace dependency. It provides:

- **`SourceParser`** — Tree-sitter parser for TypeScript, JavaScript, Python
- **`GraphBuilder`** — Constructs `CodePropertyGraph` from parsed AST
- **`ONNXEmbeddingModel`** — 2-layer GCN producing 32-dim embeddings (109KB bundled model)
- **`FAISSIndex`** — USearch-backed KNN index over component embeddings
- **`CoChangePredictor`** — High-level API: `addFile()` + `predictCochanges()`

A singleton `LocalIndex` is initialized on `init_workspace` and shared across all tool calls for the session lifetime.

---

## Tool Set

### Tool 1 — `init_workspace`

**Tier:** Local + API  
**Replaces:** `metabob-cli init`, `metabob-cli analyze`

Initialize the workspace for analysis. Parses all source files into the local CPG index and optionally syncs with the analysis server.

**Input:**

```typescript
{
  workspace_path: string;        // Absolute path to workspace root
  include: string[];             // Glob patterns to include (default: ["**/*.ts","**/*.js","**/*.py"])
  exclude: string[];             // Glob patterns to exclude (default: ["**/node_modules/**","**/.git/**"])
  sync_api: boolean;             // Sync with analysis server (default: true, no-op if no API)
}
```

**Output:**

```typescript
{
  workspace_path: string;
  files_indexed: number;
  components_found: number;
  languages: string[];
  index_time_ms: number;
  api_synced: boolean;
  session_id: string;
}
```

**Behaviour:**
1. Glob workspace files matching `include`/`exclude`
2. For each file: `parser.parseFile()` → `graphBuilder.buildGraph()` → `predictor.addFile()`
3. Build KNN index over all component embeddings
4. If `sync_api && apiClient.isConnected()`: POST `/v2/analysis/workspace/init`
5. Store `LocalIndex` singleton in session state

---

### Tool 2 — `get_problems`

**Tier:** API  
**Replaces:** `metabob-cli problems`, `get_priority_issues`

Fetch code problems from the analysis server, ranked by severity and impact.

**Input:**

```typescript
{
  limit: number;                 // Max results (default: 10, max: 100)
  severity: Array<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'>;  // Filter (default: all)
  category: string[];            // Filter by category slug (default: all)
  scope: 'session' | 'project' | 'org';  // Analysis scope (default: 'session')
  status: Array<'open' | 'in_progress' | 'complete'>;  // Filter by status (default: ['open'])
  file_path: string;             // Narrow to specific file (optional)
}
```

**Output:**

```typescript
{
  problems: Array<{
    id: string;
    component_id: string;
    file_path: string;
    start_line: number;
    end_line: number;
    severity: string;
    category: string;
    message: string;
    suggestion: string;
    impact_score: number;        // 0.0–1.0
    status: string;
    created_at: string;
  }>;
  total: number;
  scope: string;
}
```

**Endpoint:** `GET /v2/analysis/problems`

---

### Tool 3 — `search_codebase`

**Tier:** API  
**Replaces:** `search-codebase`

Semantic search over the indexed codebase using natural language.

**Input:**

```typescript
{
  query: string;                 // Natural language query
  limit: number;                 // Max results (default: 10, max: 50)
  scope: 'session' | 'project' | 'org';  // (default: 'session')
  file_filter: string[];         // Narrow to these file paths (optional)
  include_annotations: boolean;  // Include component annotations (default: true)
}
```

**Output:**

```typescript
{
  results: Array<{
    component_id: string;
    file_path: string;
    component_name: string;
    component_type: string;      // 'function' | 'class' | 'method' | ...
    start_line: number;
    end_line: number;
    score: number;               // Relevance 0.0–1.0
    snippet: string;             // Source excerpt
    annotations: Array<{ text: string; type: string; created_at: string }>;
  }>;
  total: number;
  query_time_ms: number;
}
```

**Endpoint:** `POST /v2/analysis/search`

---

### Tool 4 — `predict_cochanges`

**Tier:** Local (cpg-inference-ts)  
**Replaces:** `suggest-related-changes`

Predict which files/components should be changed together with the given files. Runs entirely locally via GCN embeddings — no API call required.

**Input:**

```typescript
{
  changed_files: string[];       // Files currently being changed (absolute or workspace-relative paths)
  limit: number;                 // Max suggestions (default: 10)
  confidence_threshold: number;  // Min similarity score 0.0–1.0 (default: 0.3)
}
```

**Output:**

```typescript
{
  suggestions: Array<{
    file_path: string;
    component_id: string;
    component_name: string;
    component_type: string;
    start_line: number;
    similarity_score: number;    // 0.0–1.0
    reason: string;              // Human-readable explanation
  }>;
  model_version: string;
  index_size: number;            // Number of components in local index
  query_time_ms: number;
}
```

**Behaviour:**
1. Look up component IDs for each file in `LocalIndex`
2. Call `predictor.predictCochanges(componentIds, limit)`
3. Filter by `confidence_threshold`, enrich with file paths from CPG
4. Returns empty list (not error) if workspace not yet indexed

**Requires:** `init_workspace` called first; gracefully degrades if not.

---

### Tool 5 — `analyze_impact`

**Tier:** Local (cpg-inference-ts) + API augmentation  
**Replaces:** `analyze-change-impact`

Analyze the downstream impact of changing the given files by traversing the Code Property Graph.

**Input:**

```typescript
{
  changed_files: string[];       // Files being changed
  diff: string;                  // Optional: git diff for precise changed-symbol resolution
  direction: 'forward' | 'backward' | 'both';  // Traversal direction (default: 'both')
  max_depth: number;             // Max graph traversal depth (default: 5, max: 10)
  include_tests: boolean;        // Include test files (default: true)
}
```

**Output:**

```typescript
{
  changed_components: Array<{
    component_id: string;
    component_name: string;
    file_path: string;
    start_line: number;
  }>;
  direct_dependents: Array<ImpactedComponent>;
  indirect_dependents: Array<ImpactedComponent>;
  affected_tests: Array<ImpactedComponent>;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  total_impacted: number;
  query_time_ms: number;
}

interface ImpactedComponent {
  component_id: string;
  component_name: string;
  file_path: string;
  start_line: number;
  depth: number;
  risk: 'low' | 'medium' | 'high';
  edge_path: string[];           // Relationship chain from changed component
}
```

**Behaviour:**
1. Resolve file paths → component IDs in local CPG
2. Run `graph.traverse(componentId, { edgeTypes: [CALLS, DEPENDS], maxDepth })` for each
3. Classify direct (depth=1) vs indirect (depth>1), separate test files
4. Risk heuristic: `critical` if >20 impacted, `high` if >5
5. If API connected: POST `/v2/analysis/impact` to augment with server-side annotations and cross-session data; merge results

---

### Tool 6 — `annotate_component`

**Tier:** API  
**Replaces:** `annotate-component`

Attach a design decision, implementation note, or warning to a code component. Persisted server-side and surfaced in search results and impact analysis.

**Input:**

```typescript
{
  component_id: string;          // Component ID from search or analysis results
  text: string;                  // Annotation content (max 2000 chars)
  type: 'decision' | 'note' | 'warning' | 'todo' | 'deprecated';
}
```

**Output:**

```typescript
{
  annotation_id: string;
  component_id: string;
  type: string;
  text: string;
  created_at: string;
  author: string;                // org_id/user_id from JWT
}
```

**Endpoint:** `POST /v2/analysis/components/{component_id}/annotations`

---

### Tool 7 — `mark_complete`

**Tier:** API  
**Replaces:** `mark-problem-complete`

Mark a problem as resolved, optionally linking to the commit that fixed it.

**Input:**

```typescript
{
  problem_id: string;            // Problem ID from get_problems
  commit_sha: string;            // Git commit SHA of the fix (optional)
  note: string;                  // Resolution note (optional, max 500 chars)
}
```

**Output:**

```typescript
{
  problem_id: string;
  status: 'complete';
  resolved_at: string;
  resolved_by: string;           // user_id from JWT
}
```

**Endpoint:** `PUT /v2/analysis/problems/{problem_id}/complete`

---

### Tool 8 — `generate_spec`

**Tier:** API  
**Replaces:** `generate-implementation-spec`

Generate a detailed implementation plan from a natural language goal. Uses the current codebase context from the analysis server.

**Input:**

```typescript
{
  goal: string;                  // What to implement (natural language, max 1000 chars)
  scope_files: string[];         // Relevant files to anchor the spec (optional)
  format: 'markdown' | 'json';  // Output format (default: 'markdown')
}
```

**Output:**

```typescript
{
  spec: string;                  // Generated implementation spec (markdown or JSON)
  affected_files: string[];      // Files the spec expects to touch
  estimated_complexity: 'trivial' | 'small' | 'medium' | 'large';
  generated_at: string;
}
```

**Endpoint:** `POST /v2/analysis/generate-spec`

---

### Tool 9 — `get_metrics`

**Tier:** API  
**Replaces:** `metabob-cli metrics`, `metabob-cli project-info`

Retrieve project-level code health metrics and summary statistics.

**Input:**

```typescript
{
  scope: 'session' | 'project' | 'org';  // (default: 'project')
  include: Array<'problems' | 'complexity' | 'coverage' | 'activity'>;  // (default: all)
}
```

**Output:**

```typescript
{
  scope: string;
  project_name: string;
  language_breakdown: Record<string, number>;   // lang → file count
  total_files: number;
  total_components: number;
  problems: {
    total: number;
    by_severity: Record<string, number>;
    by_category: Record<string, number>;
    open: number;
    resolved_last_7d: number;
  };
  complexity: {
    avg_cyclomatic: number;
    p90_cyclomatic: number;
    high_complexity_components: number;          // > 10 cyclomatic
  };
  activity: {
    tool_calls_last_7d: number;
    active_sessions: number;
  };
  generated_at: string;
}
```

**Endpoint:** `GET /v2/analysis/metrics`

---

### Tool 10 — `activity`

**Tier:** API (Activity API)  
**Replaces:** `activity.ts` (current tool, preserve interface)

Unified activity lifecycle tool for devbob workflow integration. Exposes four operations via a single tool with a discriminated `action` field.

**Input:**

```typescript
{
  action: 'resolve_impulse' | 'run_goal' | 'get_recommendations' | 'submit_trace';

  // resolve_impulse
  impulse?: {
    type: string;
    payload: Record<string, unknown>;
    context?: Record<string, unknown>;
  };

  // run_goal
  goal?: {
    goal_id: string;
    parameters?: Record<string, unknown>;
  };

  // get_recommendations
  recommendations?: {
    context: Record<string, unknown>;
    limit?: number;                              // default: 5
  };

  // submit_trace
  trace?: {
    goal_id: string;
    steps: Array<{
      tool: string;
      input: Record<string, unknown>;
      output: string;
      duration_ms: number;
      success: boolean;
    }>;
    outcome: 'success' | 'failure' | 'partial';
    total_duration_ms: number;
  };
}
```

**Output:** Action-specific response from Activity API (pass-through, formatted as text).

**Endpoints:**
- `resolve_impulse` → `POST /v2/activity/resolve-impulse`
- `run_goal` → `POST /v2/activity/goals/run`
- `get_recommendations` → `POST /v2/activity/recommendations`
- `submit_trace` → `POST /v2/activity/traces`

---

## Authentication

| Method | Env var | CLI flag | Notes |
|--------|---------|----------|-------|
| API key | `METABOB_API_KEY` | `--api-key` | Preferred. Exchanges for JWT at startup, auto-refreshes at 80% of TTL |
| JWT | `JWT_TOKEN` | `--jwt-token` | Advanced. Manual refresh required |

Local-tier tools (`predict_cochanges`, `analyze_impact` after local traversal) work without authentication.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANALYSIS_API_URL` | `http://localhost:8081` | Analysis API base URL |
| `ACTIVITY_API_URL` | `$ANALYSIS_API_URL` | Activity API base URL (if separate) |
| `METABOB_API_KEY` | — | API key |
| `JWT_TOKEN` | — | JWT (alternative to API key) |
| `SESSION_ID` | `default-session` | Session identifier |
| `WORKSPACE_PATH` | `$PWD` | Default workspace root for `init_workspace` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `HEALTH_PORT` | `8080` | Health/readiness HTTP port |
| `MAX_REQUESTS_PER_MINUTE` | `60` | Rate limit per session |

---

## Dependencies

```jsonc
// package.json additions
{
  "dependencies": {
    "@metabob/cpg-inference": "workspace:../cpg-inference-ts",  // vendored local
    "@modelcontextprotocol/sdk": "^1.0.4",
    "zod": "^3.23.8"
  }
}
```

The `cpg-inference-ts` package is referenced as a workspace dependency from the monorepo. It bundles its own ONNX model weights (`model.onnx`, 69KB) and does not require any external model download.

---

## Error Model

All tools return MCP-standard errors. Local-tier failures (e.g. file not found, parse error) use `INVALID_PARAMS`. API-tier failures map HTTP status codes:

| HTTP | MCP Error Code |
|------|---------------|
| 400 | `INVALID_PARAMS` |
| 401 | `UNAUTHORIZED` |
| 404 | `NOT_FOUND` |
| 429 | `RATE_LIMITED` (includes `retry_after_ms`) |
| 5xx | `SERVICE_UNAVAILABLE` |

Tools that have a local tier always attempt local execution first and only fail hard if the local tier also fails. API errors in a tool with a local tier are surfaced as warnings in the output text, not as MCP errors.

---

## Tool Summary

| # | Name | Tier | Replaces |
|---|------|------|---------|
| 1 | `init_workspace` | Local + API | `metabob-cli init`, `metabob-cli analyze`, `init-workspace` |
| 2 | `get_problems` | API | `metabob-cli problems`, `get_priority_issues` |
| 3 | `search_codebase` | API | `search-codebase` |
| 4 | `predict_cochanges` | **Local** | `suggest-related-changes` |
| 5 | `analyze_impact` | **Local** + API | `analyze-change-impact` |
| 6 | `annotate_component` | API | `annotate-component` |
| 7 | `mark_complete` | API | `mark-problem-complete` |
| 8 | `generate_spec` | API | `generate-implementation-spec` |
| 9 | `get_metrics` | API | `metabob-cli metrics`, `metabob-cli project-info` |
| 10 | `activity` | API | `activity` (preserved) |

**Tools dropped from current metabob-mcp:** none — all existing tools are consolidated into this set with cleaner names.  
**Tools dropped from metabob-cli:** `mcp` (this server is the MCP), `config` (env vars / CLI flags handle this).
