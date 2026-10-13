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

**Local tier** — runs entirely in-process via the vendored CPG library (`vendor/cpg-inference`, re-exported by `src/cpg-inference.ts`; a fork, not an installed package — it is absent from `package.json` dependencies and has diverged from upstream):
- Tree-sitter parsing → `CodePropertyGraph`
- GCN embeddings (109 KB bundled ONNX model, fed node-name char-codes — a name-similarity ranker, not learned structure) → USearch vector index
- BFS graph traversal

**API tier** — requires `METABOB_API_KEY` and a live session against `ide.metabob.com`:
- File submission: `POST /v2/submit` (multipart)
- Analysis results: `GET /analysis`
- Feedback: `POST /feedback/detection`

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
URL from which sibling services are derived. A remote base endpoint derives
**nothing** — no path-prefixed siblings are assumed — so a remote substrate
needs an explicit `discoveryEndpoint`; a local substrate endpoint
(`http://127.0.0.1:18080`) derives the port-offset siblings (discovery `:18100`, analysis `:18250`,
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
| `file_path` | string | — | Exact file path for the local seed cache (the primary source); substring only on the legacy vessel fan-out |
| `include_discarded` | boolean | `false` | Include dismissed false positives |

**Behaviour** — serves the local seed cache (including agent-recorded `agf_*` findings) or falls back to backend detection (`GET /analysis` / vessel fan-out — a legacy secondary source; agent-recorded findings are primary), then appends a distinct **"Findings recorded by agents on this codebase"** section recalled from concept-db: `GET {conceptDbUrl}/concepts/search?shape=code_finding` in list mode (no `query=` — semantic search is unstable on the local vessel), paged 50 rows at a time via `offset` up to 300 scanned rows, then filtered client-side to concepts mentioning the current repo name or the requested file path; hitting the scan cap is reported as truncated. concept-db unreachable is non-fatal.

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

**Behaviour** — (1) upserts one LocalStore seed per file (id `agf_<random>`, confidence 1) so `get_problems` surfaces it immediately in-session — repo/workspace attribution resolves via `activeWorkspacePath()` (index → `WORKSPACE_PATH` → cwd), so it does not require `init_workspace` in the same process; (2) best-effort `POST {conceptDbUrl}/concepts` with shape `code_finding`, source_type `metabob_annotation`, summary `[severity][category] <repo>: <summary>`, content carrying repo name, workspace-relative files, line range and details — so other agents' sessions recall it org-wide. The concept content also carries the author: `recorded_by: <vesselId>` (the same `metabob-mcp-<12 hex>` identity used for discovery registration) and `session: <sessionId>`. When no vessel identity can be resolved — no `VESSEL_ID`, no `METABOB_API_KEY` — the `recorded_by` line is **omitted entirely** rather than filled with a placeholder, so an unattributed finding reads as unattributed instead of as someone's. concept-db unreachable is non-fatal and reported in the output. Close the loop with `mark_complete` on the returned `agf_*` id.

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

Predict which files and components should be changed together with the given files. Runs entirely locally — no API call. **Git-history co-change mining carries all of the signal.** The bundled GCN contributes a second list that should be treated as noise: its input features are the node name's char-codes (`src/cochange-predictor.ts:176-188`), and `infer()` is called one node at a time (`src/cochange-predictor.ts:80-81`), so the star edge index is always empty (`vendor/cpg-inference/src/embedding-model.ts:121,314-317`) and no graph structure reaches the model. Rank on the git-history section; do not act on a GCN-only suggestion.

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

Calls `GET /analysis`, finds the matching problem ID, and returns structured notes. An `agf_*` id is served from the LocalStore seed instead (no API call), rendering severity/category/file/refs/status plus the same why/how notes — so record → annotate → mark_complete works on agent findings.

---

### mark_complete

Mark a detected problem as resolved or dismiss it as a false positive.

**Input**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `problem_id` | string | **required** | Problem ID from `get_problems` |
| `action` | `endorse\|discard` | `endorse` | endorse=fixed, discard=false positive |

Calls `POST /feedback/detection`. A `concept_*` id is also accepted — the cross-agent recall surfaces findings by concept id, so that is often the only identifier an agent holds; it is resolved to its local `agf_*` seed via `LocalStore.getSeedByConceptRef`. When no local seed exists, the verdict is written from the recalled concept itself (the fleet case: one agent records, another fixes) — keyed on the `agf_*` id the finding carries, never the concept id — and the output states plainly that nothing local was retired. For agent-recorded findings the legacy API is bypassed: endorse marks the LocalStore seed stale (resolved, stops surfacing), discard deletes the local seed only — the org-wide `code_finding` concept is never retracted — and a `finding_verdict` concept referencing the finding id is best-effort recorded to concept-db (non-fatal). Every verdict carries its reviewer and its provenance as two separate content lines: `reviewed_by: <vesselId>` + `session: <sessionId>` (the author — omitted when no identity resolves), and `origin: local` (written against a local seed) or `origin: remote` (written from a recalled concept). `recorded_by` never appears on a verdict; it means author-of-finding and nothing else. Additionally, when the finding seed carries a linked `code_finding` concept (stashed by `record_finding` in `refs_json`), the verdict is folded straight into that concept's **relevance** via a usage signal — endorse → `success`, discard → `failure` (`POST /concepts/:id/usage`) — so operator judgment moves the Bayesian relevance score, not just a parallel verdict concept.

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
| `scope` | `session\|project\|org` | `session` | Accepted for compatibility; the handler does not read it |

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
| `provide_feedback` | FEEDBACK | Record an operator verdict (`reached`/`not_reached`/`partial` + rationale + confidence) → records a `goal_verification_labels` oracle-corpus label, consumed by offline audit rather than by an automated reach-gate. Auto-derives goal/executionId/template from the dispatch record. |
| `registry_query` | INSPECT | Discovery registry: `mode:"shapes"` (vocabulary, optional `shape` substring) / `mode:"vessels"` (who serves a `shape`). Replaces `curl discovery`. |
| `execution_trace` | INSPECT | Durable trace by `execution_id`: status, template, chain, load-bearing tags (`state_signature:`, `reached:`, `completion_shapes:`, `operator:`), per-task sequence + failure_mode. Replaces raw trace curls. |
| `resolve_impulse` | INSPECT | Advanced escape hatch: resolve/write ANY impulse shape (`memoryNote`, `feature_compose`, `*_write`, …). `activity_api:true` → activity-api; `vessel_shape` → owning vessel via discovery. Prefer dedicated tools when they fit. |

**`reached`, not `status`.** `status` (`running|completed|failed`) is only the template *exit status*. **`reached`** (`yes|no`) is the goal-reach verdict and the load-bearing signal — surfaced first by `goal_status`/`goal_reasoning`. `completed`+`reached:false` (hollow) and `failed`+`reached:true` (e.g. satisfier reach) are both normal; trusting `status` mis-judges the outcome. High-stakes → also read the actual diff/output (a change can typecheck + pass the reach-gate yet not do what was asked). Every dispatch auto-stamps `operator:<id>` (default `claude-code-operator`, override `MB_OPERATOR_ID`) into the trace tags.

**Canonical loop:** `run_goal_async` → `goal_status` → `goal_reasoning` → `provide_feedback`, annotated in CLAUDE.md § Tools.

> Also available: `concept_*` (concept-db graph — see the `metabob-substrate` skill), including **`concept_record_usage`** — the direct write into concept-db's relevance model. `POST /concepts/:id/usage` with `outcome` ∈ `success|failure|neutral`; concept-db folds it into the Bayesian posterior mean `(times_succeeded+1)/(times_loaded+2)` (`success` credits and raises relevance; `failure`/`neutral` grow the load denominator). `mark_complete` on a finding uses this same channel. Note the MCP server runs the compiled `dist/cli.js`; after editing `src/`, `bun run build` before a reconnect or new/changed tools stay stale.

---

## Agent-resolver tools (Claude-Code-as-implicit-vessel, write half)

The cockpit is not only a client that dispatches goals INTO the substrate — the
agent can also act as a **resolver the substrate dispatches work TO**. When
enabled (opt-in `METABOB_AGENT_RESOLVER=1`; off by default), the vessel advertises
the `human_input` shape, so a goal-host walk that exhausts its automated
approaches solicits a decision from this agent. The vessel durably enqueues the
task; the agent drains it with these tools. `goal_reasoning` is the read half of
the same "Claude-Code-as-implicit-vessel" idea — this is the write half.

| Tool | Behaviour |
|------|-----------|
| `pull_assigned_work` | Claim tasks the substrate dispatched to this agent-resolver. Returns each `task_id` + `question`. Tasks are **durable and keyed by the stable vesselId**, so work assigned while you were away in a prior session surfaces now. Params: `limit` (default 10). |
| `submit_resolution` | Answer a task: `{ task_id, outcome: "answered"\|"declined"\|"insufficient_context", answer? }` (answer required when `answered`). The answer is recorded durably FIRST, then delivered to goal-host as `solicitationResponse_write` to unblock its parked walk. If the substrate is briefly unreachable the answer stays queued and is retried automatically on the next session's startup — the cross-session provide-info-back guarantee. |

**Cross-session coordination.** Tasks and answers persist in `~/.metabob/sidecar.db`,
partitioned by the vesselId (`metabob-mcp-<hash(apiKey+workspace)>`). A later
session in the same workspace+key re-derives the identical id and resumes: it
sees still-pending tasks (`pull_assigned_work`) and re-delivers any answer a
prior session recorded but couldn't send. Loop: substrate solicits →
`pull_assigned_work` → reason → `submit_resolution`.

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

5. record_finding(files, summary, severity, category)
   → the write half: attribute what you found to the code; returns agf_* ids
     and mints a code_finding concept other agents recall org-wide

6. annotate_component(problem_id | agf_id, mode="recommend")
   → structured why/how notes

7. mark_complete(problem_id | agf_* | concept_*, action="endorse")
   → verdict; on findings it also folds relevance into concept-db

8. pull_assigned_work() / submit_resolution(task_id, outcome, answer)
   → answer decisions the substrate dispatched to this agent

9. init_workspace(recently_changed_files=[...new files...])
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
| `human_input` | queued, not resolved inline — durably enqueued for `pull_assigned_work` / `submit_resolution`; the POST ACKs immediately |

Auth: `Authorization: ApiKey <METABOB_API_KEY>`
