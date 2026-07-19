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
- Problem details: `GET /analysis`

---

## Configuration

**Minimal setup is a single value: an API key.** Everything else derives.

Two equivalent ways to supply it:

```bash
# Environment (typical .mcp.json / MCP-client setup)
METABOB_API_KEY=mb_live_...          # required
METABOB_ENDPOINT=https://ide.metabob.com   # optional — this IS the default
```

```jsonc
// ~/.metabob/config.json (or METABOB_CONFIG_PATH)
{
  "metabob": {
    "apiKey": "mb_live_...",
    "endpoint": "https://ide.metabob.com"   // optional — same default
  }
}
```

Config resolution is **directory-aware, like git**: a project can pin its own
backend with `.metabob/config.json` in the directory the server is launched
from (MCP clients spawn stdio servers with cwd = project root). Lookup order:
`METABOB_CONFIG_PATH` → `./.metabob/config.json` → `~/.metabob/config.json`.

`endpoint` / `METABOB_ENDPOINT` is the **gateway in the vessel**: the single
URL from which every sibling service is derived. A remote base endpoint
derives path-prefixed siblings (`/analysis`, `/discovery`, `/identity`,
`/conceptdb`); a local substrate endpoint (`http://localhost:18080`) derives
the port-offset siblings (discovery `:18100`, analysis `:18250`,
concept-db `:18260`).

### Config-file schema (all keys optional)

| Key | Purpose |
|-----|---------|
| `metabob.apiKey` | API key (also accepted at legacy `instance.apiKey`) |
| `metabob.endpoint` | Gateway URL — everything below derives from it |
| `metabob.discoveryEndpoint` | Advanced: pin discovery-vessel explicitly |
| `metabob.analysisApiUrl` | Advanced: pin the analysis API explicitly |
| `metabob.identityEndpoint` | Advanced: pin identity (tenant resolution) explicitly |
| `metabob.conceptDbUrl` | Advanced: pin concept-db explicitly |
| `metabob.goalHostVesselUrl` | Advanced: pin goal-host-vessel explicitly |

Unknown keys are ignored (passthrough). Each explicit key wins over its
derived value; the same is true of the corresponding env vars
(`ANALYSIS_API_URL`, `DISCOVERY_ENDPOINT`, `IDENTITY_ENDPOINT`,
`CONCEPT_DB_URL`, `GOAL_HOST_VESSEL_URL`).

### Precedence (lowest → highest)

1. Built-in default — API key alone routes everything to `https://ide.metabob.com`
2. `~/.metabob/config.json`
3. Environment (`METABOB_ENDPOINT` derivation; specific env vars)
4. CLI flags (`--endpoint`, `--api-key`; `--api-url` as the raw analysis override)

Two guarantees worth knowing:

- A **file-supplied `endpoint` beats the built-in default** even when the API
  key arrives via env — an MCP client injecting `METABOB_API_KEY` cannot
  silently redirect a config file pointed at a local substrate.
- **Legacy carve-out**: pinning a specific endpoint var (e.g.
  `ANALYSIS_API_URL`) *without* `METABOB_ENDPOINT` keeps gateway derivation
  inert, so hand-configured routing is never split-brained onto the default
  gateway.

---

## Tools

### init_workspace

Initialize the local CPG index and incrementally sync the most relevant files to the analysis server. Call repeatedly as you work — each call submits one small batch ranked by relevance to recently changed files.

Analysis is asynchronous: after submission, the server may continue processing in the background and later calls may still see `pending` or `running`. Agents should prefer async follow-up when working with Metabob.

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
5. Uses a longer submission timeout than ordinary API calls; if the server is slow to answer, prefer async follow-up with `get_analysis_context` or `get_problems`.
6. Does not wait for backend analysis to finish; use `get_analysis_context` or `get_problems` to check progress later.

---

### get_problems

Fetch known problems for this codebase, ranked by severity: backend detections plus findings recorded by agents (`record_finding`) working on the same region. If analysis is still running, the tool reports that state instead of blocking until completion.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | `10` | Max results (max 100) |
| `severity` | `CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO`[] | all | Filter by severity |
| `category` | string[] | all | Filter by category slug |
| `file_path` | string | — | Substring match on file path |
| `include_discarded` | boolean | `false` | Include dismissed false positives |

**Behaviour** — serves the local seed cache (including agent-recorded `agf_*` findings) or falls back to backend detection (`GET /analysis` / vessel fan-out — deprecated as the primary source), then appends a distinct **"Findings recorded by agents on this codebase"** section recalled from concept-db: `GET {conceptDbUrl}/concepts/search?shape=code_finding&limit=50` (list mode, no `query=`), filtered client-side to concepts mentioning the current repo name or the requested file path. concept-db unreachable is non-fatal.

---

### record_finding

The write half of agent-side analysis: LLM processing lives on the agent; the server attributes agent-noticed details to code and surfaces them to other agents on the same codebase.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `files` | string[] | **required** | Files the finding is attributed to (workspace-relative or absolute) |
| `summary` | string | **required** | One-line description |
| `details` | string | — | Longer explanation / suggested fix |
| `severity` | `CRITICAL\|HIGH\|MEDIUM\|LOW\|INFO` | **required** | Severity |
| `category` | string | **required** | Free-form slug (security, correctness, design-constraint, …) |
| `line_start` | number | — | Start line |
| `line_end` | number | — | End line |
| `status` | string | `open` | Finding status |

**Behaviour** — (1) upserts one LocalStore seed per file (id `agf_<random>`, confidence 1) so `get_problems` surfaces it immediately in-session; (2) best-effort `POST {conceptDbUrl}/concepts` with shape `code_finding`, source_type `metabob_annotation`, summary `[severity][category] <repo>: <summary>`, content carrying repo name, workspace-relative files, line range and details — so other agents' sessions recall it org-wide. concept-db unreachable is non-fatal and reported in the output. Close the loop with `mark_complete` on the returned `agf_*` id.

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

Add structured notes for a detected problem using the current analysis result.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` |
| `mode` | `explain\|recommend` | `explain` | `explain` adds why-focused notes, `recommend` adds how-to-fix notes |
| `context` | string | — | Additional context to include in the notes |

Calls `GET /analysis`, finds the matching problem ID, and returns structured notes.

---

### mark_complete

Mark a detected problem as resolved or dismiss it as a false positive.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` |
| `action` | `endorse\|discard` | `endorse` | endorse=fixed, discard=false positive |

Calls `POST /feedback/detection`. For agent-recorded findings (`agf_*` ids from `record_finding`) the legacy API is bypassed: endorse marks the LocalStore seed stale (resolved, stops surfacing), discard deletes it, and a `finding_verdict` concept referencing the finding id is best-effort recorded to concept-db (non-fatal). Additionally, when the finding seed carries a linked `code_finding` concept (stashed by `record_finding` in `refs_json`), the verdict is folded straight into that concept's **relevance** via a usage signal — endorse → `success`, discard → `failure` (`POST /concepts/:id/usage`) — so operator judgment moves the Bayesian relevance score, not just a parallel verdict concept.

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

Return the current analysis state: CPG index stats, open problems summary, co-change predictions for recently changed files, and a compact top-5 recall of findings recorded by agents on this codebase (concept-db `code_finding` concepts, non-fatal when unreachable). Designed to feed an LLM deciding what to do next.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recently_changed_files` | string[] | `[]` | Used to generate co-change predictions |
| `problem_limit` | number | `10` | Max open problems to include |
| `scope` | `session\|project\|org` | `session` | Problem scope |

---

## Substrate goal tools (the operator cockpit)

Beyond the CPG-analysis tools above, the MCP surface drives the running substrate end-to-end — **dispatch work, understand it, verify it, inspect it — without host access** (`docker exec` / `journalctl` / raw `curl` are the last resort, not the default). They resolve goal-host / discovery / activity-api through discovery-vessel; they need `metabob.endpoint` + `apiKey` in `~/.metabob/config.json`.

Three planes + a coverage set:

| Tool | Plane | Behaviour |
|------|-------|-----------|
| `run_goal` | ACT | Synchronous dispatch via goal-host `POST /resolve` (~290s cap). Short goals answered inline. |
| `run_goal_async` | ACT | Async dispatch via goal-host `POST /run-goal` → `dispatchId` immediately. Default for non-trivial goals. **Names a `repos/<vessel>/src/…` file → routes to `feature_compose`, which drafts + typecheck-verifies + lands a real traced commit** (no byte-exact trick needed). |
| `goal_status` | ACT | Poll a `dispatchId` → the honest **`reached`** verdict (primary), executionId/template, hydrated roll-up (state signature, produced shapes, failure mode, Thompson α/β). |
| `goal_reasoning` | REASON | The goal-host **walk decision-log** for a `dispatchId`: goal-target inference → satisfier/bridge/step decisions → reach verdict + per-task trace sequence. *Why* it reached or fell short. Renders the `walkLog` for satisfier-only reaches (no template trace). |
| `provide_feedback` | FEEDBACK | Record an operator verdict (`reached`/`not_reached`/`partial` + rationale + confidence) → writes a `goal_verification_labels` oracle-corpus label that calibrates the reach-gate. Auto-derives goal/executionId/template from the dispatch record. |
| `registry_query` | INSPECT | Discovery registry: `mode:"shapes"` (vocabulary, optional `shape` substring) / `mode:"vessels"` (who serves a `shape`). Replaces `curl discovery`. |
| `execution_trace` | INSPECT | Durable trace by `execution_id`: status, template, chain, load-bearing tags (`state_signature:`, `reached:`, `completion_shapes:`, `operator:`), per-task sequence + failure_mode. Replaces raw trace curls. |
| `resolve_impulse` | INSPECT | Advanced escape hatch: resolve/write ANY impulse shape (`memoryNote`, `feature_compose`, `*_write`, …). `activity_api:true` → activity-api; `vessel_shape` → owning vessel via discovery. Prefer dedicated tools when they fit. |

**`reached`, not `status`.** `status` (`running|completed|failed`) is only the template *exit status*. **`reached`** (`yes|no`) is the goal-reach verdict and the load-bearing signal — surfaced first by `goal_status`/`goal_reasoning`. `completed`+`reached:false` (hollow) and `failed`+`reached:true` (e.g. satisfier reach) are both normal; trusting `status` mis-judges the outcome. High-stakes → also read the actual diff/output (a change can typecheck + pass the reach-gate yet not do what was asked). Every dispatch auto-stamps `operator:<id>` (default `claude-code-operator`, override `MB_OPERATOR_ID`) into the trace tags.

**Canonical loop:**

```
run_goal_async({ goal })        → dispatchId       (name a repos/<vessel>/src file for code changes)
goal_status({ dispatch_id })    → read `reached`, not `status`
goal_reasoning({ dispatch_id }) → the walk decision-log: why it reached / fell short
provide_feedback({ dispatch_id, verdict, rationale })  → verdict into the oracle corpus
```

> Also available: `concept_*` (concept-db graph — see the `metabob-substrate` skill), including **`concept_record_usage`** — the direct write into concept-db's relevance model. `POST /concepts/:id/usage` with `outcome` ∈ `success|failure|neutral`; concept-db folds it into the Bayesian posterior mean `(times_succeeded+1)/(times_loaded+2)` (`success` credits and raises relevance; `failure`/`neutral` grow the load denominator). This makes the agent a first-class, deliberate relevance contributor rather than relying only on the passive load event `concept_search` fires and cross-vessel goal executions. `mark_complete` on an `agf_*` finding uses this same channel to fold its verdict into the finding concept's relevance. Note the MCP server runs the compiled `dist/cli.js`; after editing `src/`, `bun run build` before a reconnect or new/changed tools stay stale.

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
