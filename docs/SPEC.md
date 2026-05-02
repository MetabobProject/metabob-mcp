# @metabob/mcp — Tool Specification

## Architecture

```
Agent (Claude Code / Cursor / custom)
        │  MCP over stdio (JSON-RPC 2.0)
        ▼
┌─────────────────────────────────────────┐
│             @metabob/mcp                │
│                                         │
│  Tool Registry (src/tools/index.ts)     │
│                                         │
│  Local tier           API tier          │
│  ────────────────     ──────────────    │
│  cpg-inference-ts     AnalysisAPIClient │
│  (in-process)         (ide.metabob.com) │
└─────────────────────────────────────────┘
```

**Local tier** — runs entirely in-process via `@metabob/cpg-inference`:
- Tree-sitter parsing → `CodePropertyGraph`
- GCN embeddings (109 KB bundled ONNX model) → USearch vector index
- BFS graph traversal

**API tier** — requires `METABOB_API_KEY` and a live session against `ide.metabob.com`:
- File submission: `POST /v2/submit` (multipart)
- Analysis results: `GET /analysis`
- Feedback: `POST /feedback/detection`
- Explain / recommend: `POST /explain`, `POST /recommend`

---

## Tools

### init_workspace

Initialize the local CPG index and incrementally sync the most relevant files to the analysis server. Call repeatedly as you work — each call submits one small batch ranked by relevance to recently changed files.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `workspace_path` | string | `$WORKSPACE_PATH` or cwd | Absolute path to workspace root |
| `recently_changed_files` | string[] | `[]` | Changed files — prioritised in sync batch |
| `batch_size` | number | `5` | Files to submit per call (max 20) |
| `include` | string[] | `[ts,tsx,js,jsx,mjs,cjs,py]` | Extensions to index |
| `exclude` | string[] | `[node_modules,.git,dist,...]` | Directories to skip |
| `sync_api` | boolean | `true` | Submit batch to analysis server |

**Behaviour**
1. Scans workspace and builds/updates the local CPG.
2. Ranks files: recently changed → CPG co-change neighbours → same directory → alphabetical.
3. Submits `batch_size` files to `POST /v2/submit`.
4. Reports how many files remain unsynced.

---

### get_problems

Fetch code problems detected by the analysis server for this session, ranked by severity.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | `10` | Max results (max 100) |
| `severity` | `CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO`[] | all | Filter by severity |
| `category` | string[] | all | Filter by category slug |
| `file_path` | string | — | Substring match on file path |
| `include_discarded` | boolean | `false` | Include dismissed false positives |

**Behaviour** — calls `GET /analysis`, client-side filters, sorts by severity then file path.

---

### search_codebase

Search components (local CPG) and problems (analysis results) by keyword.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | **required** | Matched against component names, file paths, categories, summaries |
| `limit` | number | `10` | Max results (max 50) |
| `target` | `components\|problems\|both` | `both` | What to search |
| `file_filter` | string[] | — | Narrow to these file paths (substring) |

Requires `init_workspace` for component results.

---

### predict_cochanges

Predict which files and components should be changed together with the given files. Runs entirely locally via the embedded GCN model — no API call.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changed_files` | string[] | **required** | Files being changed |
| `limit` | number | `10` | Max suggestions |
| `confidence_threshold` | number | `0.3` | Min similarity score (0.0–1.0) |

Requires `init_workspace`.

---

### analyze_impact

Analyze which components are affected by changing the given files, by traversing the local Code Property Graph.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changed_files` | string[] | **required** | Files being changed |
| `diff` | string | — | Git diff for line-precise symbol resolution |
| `direction` | `forward\|backward\|both` | `both` | forward=dependencies, backward=dependents |
| `max_depth` | number | `5` | Max traversal depth (max 10) |
| `include_tests` | boolean | `true` | Include test files |

Requires `init_workspace`.

---

### annotate_component

Get an AI-generated explanation or fix recommendation for a detected problem.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` |
| `mode` | `explain\|recommend` | `explain` | Explanation or fix recommendation |
| `context` | string | — | Additional context for the AI |

Calls `POST /explain` (mode=explain) or `POST /recommend` (mode=recommend).

---

### mark_complete

Mark a detected problem as resolved or dismiss it as a false positive.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` |
| `action` | `endorse\|discard` | `endorse` | endorse=fixed, discard=false positive |

Calls `POST /feedback/detection`.

---

### get_metrics

Retrieve session and project analysis health. Parallel fetch of `/metrics`, `/session/stats`, and `/analysis`.

**Input** — none

**Output** — problem counts by severity and category, session statistics, API health.

---

### assign_git_changes

Assign changed files to the CPG components they affect. Returns a file→component map and co-change predictions per component.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `changed_files` | string[] | **required** | Changed file paths |
| `diff` | string | — | Git diff for line-precise attribution |
| `include_cochange_predictions` | boolean | `true` | Include co-change predictions per component |
| `prediction_limit` | number | `5` | Max co-change predictions per file |

Requires `init_workspace`.

---

### get_analysis_context

Return the current analysis state: CPG index stats, open problems summary, and co-change predictions for recently changed files. Designed to feed an LLM deciding what to do next.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recently_changed_files` | string[] | `[]` | Used to generate co-change predictions |
| `problem_limit` | number | `10` | Max open problems to include |
| `scope` | `session\|project\|org` | `session` | Problem scope |

---

## Typical agent workflow

```
1. init_workspace(workspace_path, recently_changed_files)
   → builds local CPG, submits first batch

2. get_analysis_context(recently_changed_files)
   → snapshot: index stats + open problems + co-change hints

3. get_problems(severity=["HIGH","CRITICAL"])
   → full problem list for triage

4. predict_cochanges(changed_files) / analyze_impact(changed_files)
   → local CPG queries, no API call

5. annotate_component(problem_id, mode="recommend")
   → AI fix suggestion

6. mark_complete(problem_id, action="endorse")
   → record fix

7. init_workspace(recently_changed_files=[...new files...])
   → sync next batch as work progresses
```

## Impulse shapes (HTTP resolver)

The vessel also accepts `POST /v2/impulses/resolve` from the activity system:

| Shape | Maps to |
|-------|---------|
| `mcp:tool_call` | any tool by name via `pointer.tool` + `pointer.input` |
| `code:cochange_prediction` | `predict_cochanges` |
| `code:impact_analysis` | `analyze_impact` |
| `code:git_change_assignment` | `assign_git_changes` |
| `code:analysis_context` | `get_analysis_context` |

Auth: `Authorization: ApiKey <METABOB_API_KEY>`
