# @metabob/mcp

MCP bridge and local CPG analysis vessel. Exposes Metabob analysis capabilities to AI agents via two protocols:

- **MCP (stdio)** — Claude Code, Cursor, Continue, and other MCP clients
- **HTTP resolver (`HEALTH_PORT`, ephemeral by default)** — activity system invokes tools via impulse pointers

**No workspace content leaves the machine.** The server is an agent cockpit plus substrate integration: `init_workspace` reads files into an in-process CPG and nowhere else, nothing watches the workspace or submits files, excerpts or file lists for analysis, and so there is no server-side analysis — problems are what agents record (`record_finding`). Telemetry carries usage events, not file content (§ Telemetry).

Auth: `METABOB_API_KEY` authenticates each analysis request directly — there is no `POST /session` token exchange. The exchange path runs only under `METABOB_STATELESS=true`, which selects the legacy REST surface and refreshes an opaque session token on a timer. The same key also resolves a tenant JWT from the identity vessel at `ide.metabob.com/identity` (used for the HTTP impulse resolver) — identity resolution routes through the single public endpoint, never a specialized host.

## Quick reference

```bash
bun run dev                         # start with watch mode
bun run typecheck                   # tsc --noEmit
bun test                            # run tests
bun run build                       # compile src/ → dist/cli.js (required for npm link)
npm link                            # register metabob-mcp bin globally for local testing
bash scripts/git-hooks/install.sh   # install pre-commit + pre-push hooks
node scripts/doclinks.mjs check     # docs ↔ code links: must report 0 errors
```

## Branching

Branch off `dev` and open PRs into `dev`; `main` advances only by a version-bumped checkpoint whose commits are already on `dev`, never by direct feature work. The `pre-push` hook enforces both conditions — see `scripts/git-hooks/README.md` § Branch policy for the exact rules and the emergency override. Run `bash scripts/git-hooks/install.sh` once per clone to activate.

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — auth lifecycle, MCP server, refresh timers, shutdown |
| `src/api-client.ts` | HTTP client to the analysis API — `ApiKey` auth (session exchange under `METABOB_STATELESS=true`), feedback on non-`agf_*` problem ids, health. It has no file-submission path |
| `src/auth-service.ts` | Identity-vessel auth — tenant resolution, JWT refresh, key-issuance heartbeat |
| `src/vessel-server.ts` | Hono HTTP server — `/health`, `/v2/capabilities`, `POST /v2/impulses/resolve`. Capabilities are also served on request via `/v2/capabilities` + identity tenant resolution |
| `src/local-index.ts` | Singleton `LocalIndex` wrapping `CoChangePredictor`, backed by the vendored CPG fork under `vendor/cpg-inference` (re-exported by `src/cpg-inference.ts`; not an npm dependency). Rebuilt in-memory per process launch — the CPG/index is not persisted across restarts (re-run `init_workspace`) |
| `src/tools/index.ts` | Tool registry — maps tool names to handlers |
| `docs/SPEC.md` | Full tool specification with input/output schemas |
| `docs/links.json` | Docs ↔ code link database, maintained by `scripts/doclinks.mjs` (see `docs/DOCLINKS.md`) |

## Tools

| Tool | Tier | Key behaviour |
|------|------|--------------|
| `init_workspace` | **Local** | Parses the workspace into the in-process CPG; makes no request. `batch_size` / `sync_api` are accepted and ignored |
| `get_problems` | Local + Substrate | Problems ranked by severity: the local store's seeds (incl. agent-recorded `agf_*` findings) plus a "Findings recorded by agents on this codebase" section recalled from concept-db (`code_finding` concepts, list-mode, filtered client-side to the current repo/files). The recall runs first and retires this session's local seeds of any finding it shows closed, so a verdict recorded by another session leaves the open list here too. States that there is no server-side analysis |
| `record_finding` | Local + Substrate | The write half of agent-side analysis: attribute an agent-noticed issue (files, summary, severity, category, optional lines/details) to code. Upserts a LocalStore seed (`agf_*` id — surfaces immediately via `get_problems`) and best-effort mints a `code_finding` concept into concept-db so other agents on this codebase recall it, stamped with `recorded_by: <vesselId>` + `session: <sessionId>` in the concept content (the author line is **omitted**, never faked, when no vessel identity resolves). concept-db unreachable = non-fatal, reported in output. |
| `search_codebase` | **Local** | Keyword search over CPG nodes and the local store's findings |
| `predict_cochanges` | **Local** | Git-history co-change mining — the only informative signal. No API call; needs `init_workspace`. The bundled ONNX GCN contributes a secondary ranking that carries **no** graph signal and should be read as noise: nodes are embedded one at a time (`src/cochange-predictor.ts@addFile`), so the edge index is always empty, and the sole input feature is node-name char-codes |
| `analyze_impact` | **Local** | BFS over local CPG; shows affected components by depth |
| `annotate_component` | **Local** | Why/how notes built locally from templates for a problem id held in the local store (`agf_*` findings); any other id is reported as not found, since there is no server-side analysis |
| `mark_complete` | API / Local | Endorse (fixed) or discard (false positive). A backend problem goes to `POST /feedback/detection` (legacy REST) or a `resolution` event on `POST /v2/events/mcp` (vessel mode). For agent findings: endorse marks the LocalStore seed stale, discard deletes the **local seed only** (the org-wide `code_finding` concept is never retracted), a `finding_verdict` concept is best-effort recorded to concept-db, and — closing the relevance loop — the verdict is folded directly into the finding concept's relevance via a usage signal (endorse→`success`, discard→`failure`) when the seed carries a linked `concept:` id. Accepts a `concept_*` id too (the form cross-agent recall hands you) and resolves it to its `agf_*` seed via `LocalStore.getSeedByConceptRef`; with no local seed the verdict is written from the recalled concept itself (still keyed on the finding's `agf_*` id) and the output states that nothing local was retired. Both paths stamp the verdict with `reviewed_by: <vesselId>` + `session: <sessionId>` and a separate `origin: local` / `origin: remote` provenance line — author and locality are never folded into one key. |
| `get_metrics` | **Local** | Open findings in the local store by severity, source and category, plus the local CPG size; makes no request and states that there is no server-side analysis |
| `assign_git_changes` | **Local** | Maps changed files → CPG components + co-change predictions + local-store findings in those files |
| `get_analysis_context` | Local + Substrate | Snapshot of CPG stats + open problems from the local store + co-change predictions + compact top-5 recall of other agents' recorded findings for this codebase |
| `run_goal` | Substrate | Dispatch a goal **synchronously** via goal-host's resolve endpoint (impulse shape `goal_execution`); blocks up to `RUN_GOAL_TIMEOUT_MS` (default 290 s). Short, one-shot goals. |
| `run_goal_async` | Substrate | Dispatch a goal **asynchronously** via goal-host `POST /run-goal`; returns a `dispatchId` immediately. Long goals / fire-and-forget. |
| `goal_status` | Substrate | Poll a `dispatchId` → the honest **`reached`** verdict (primary line), then `status`/executionId/template + hydrated trace (state-space signature, produced shapes, failure mode, Thompson α/β). Read `reached`, not `status` — `completed`≠reached, and a satisfier reach can be `status:"failed"` yet `reached:true`. |
| `goal_reasoning` | Substrate | The "reason plane": reconstruct the goal-host walk's decision-log for a `dispatchId` — ordered per-task walk steps (resolver + tier, shapes consumed → produced, success, failure_mode), reach verdict, Thompson α/β. Richer than `goal_status`: it renders the goal-host `walkLog` whenever the dispatch record has one, and says the decision-log is unavailable when there is neither a `walkLog` nor trace tasks (typically a direct vessel resolve). |
| `provide_feedback` | Substrate | The "feedback plane": record an operator verdict (`reached`/`not_reached`/`partial` + rationale + confidence) on a `dispatchId` → records a ground-truth label into the substrate's oracle corpus (`goal_verification_labels`), consumed by offline audit (an obsidian-vessel reach-rate note) rather than by an automated reach-gate. Reads goal/executionId/template from goal-host's dispatch record (`goal` may be supplied); a pruned (404) or still-running dispatch cannot be labelled. Pair with `goal_reasoning`: inspect the walk, then endorse or correct it. Measured feedback, not advice. Folds the operator id into the label notes. |
| `registry_query` | Substrate | Inspect discovery-vessel's registry directly, without host access. `mode:"shapes"` lists the advertised shape vocabulary from `GET /registry/shapes` (optional `shape` substring filter, applied client-side); `mode:"vessels"` (requires `shape`) lists vessels advertising a shape (vesselId, endpoint, protocol, resolve_endpoint) via the `vesselCapability` pointer. |
| `execution_trace` | Substrate | Read a durable execution trace by `execution_id` from activity-api (`GET /v2/activities/execution-traces/:id`) — status, activity_template_id, composition_chain, load-bearing tags (`state_signature:`, `reached:`, `completion_shapes:`, `operator:`), and per-task sequence (`#N ✓/✗ resolver/tier inShapes → outShapes` + failure_mode). `goal_reasoning` renders the same trace for a dispatch. 404 (satisfier-only reach) handled gracefully. |
| `resolve_impulse` | Substrate | ADVANCED escape hatch: general impulse-resolve passthrough for ANY shape (memoryNote, feature_compose, `*_write`, …) instead of raw `curl /v2/impulses/resolve`. `activity_api:true` → activity-api; `vessel_shape` → owning vessel via discovery; else defaults to activity-api. Prefer the dedicated tools when they fit. |
| `concept_*` | Substrate | concept-db graph: `concept_search` / `_neighbors` / `_usage_stats` / `_sequence` / `_link` / `_create` / `_record_usage`. See docs/SPEC.md § Concept graph tools. |
| `concept_record_usage` | Substrate | The direct write into concept-db's **relevance** model — `POST /concepts/:id/usage`. Attribute an outcome to a concept you used: `success` credits it (raises relevance), `failure`/`neutral` grow the load count without credit. concept-db folds it into the Bayesian posterior mean `(times_succeeded+1)/(times_loaded+2)`. Makes the agent a first-class, deliberate relevance contributor rather than relying only on passive read-loads and cross-vessel executions. |
| `pull_assigned_work` | Resolver | Claim tasks the substrate *dispatched to you* (solicited `human_input` decisions). Durable + keyed by the stable vesselId, so work assigned in one session surfaces in later sessions. With the agent-resolver role off (the default) and nothing queued, it reports that no task can arrive and names the `METABOB_AGENT_RESOLVER=1` opt-in. |
| `submit_resolution` | Resolver | Answer a pulled task (`{task_id, outcome, answer?}`). Recorded durably, then delivered to goal-host as `solicitationResponse_write` to unblock its walk; retried on a later session if the substrate was unreachable. An unknown `task_id` with the role off names the opt-in. |

**Substrate tools** (`run_goal*`, `goal_status`, `goal_reasoning`, `provide_feedback`, `registry_query`, `execution_trace`, `resolve_impulse`, `concept_*` incl. `concept_record_usage`) locate their targets without assuming a fixed sibling URL: goal-host-vessel is `GOAL_HOST_VESSEL_URL` or else discovered by its `goal_execution` shape (loopback endpoints rehosted onto a remote discovery's host); concept-db is `CONCEPT_DB_URL` (set or derived) or else discovered by its `conceptGraph` shape; activity-api is `ACTIVITY_API_URL` / `ANALYSIS_API_URL`; `registry_query` talks to discovery itself. Config resolution is directory-aware, like git: `METABOB_CONFIG_PATH` → `./.metabob/config.json` (launch directory; lets a project pin its own backend) → `~/.metabob/config.json`. A local substrate endpoint (`http://127.0.0.1:18080`) needs only `metabob.apiKey` + `metabob.endpoint` — it auto-derives `DISCOVERY_ENDPOINT=…:18100` and the other port-offset siblings; a remote base endpoint derives **nothing** — no path-prefixed siblings are assumed (no live node serves them), so a remote substrate needs an explicit `DISCOVERY_ENDPOINT` / `metabob.discoveryEndpoint`. An explicit `METABOB_ENDPOINT` takes only the credentials from a config file, never its endpoints, so the two can't split across substrates. Explicit `GOAL_HOST_VESSEL_URL` / `CONCEPT_DB_URL` / `DISCOVERY_ENDPOINT` (or per-service config keys) override derivation.

**The surface is a complete operator cockpit — no host access needed.** Three planes + a coverage set: ACT (`run_goal*`), TRACK (`goal_status`), REASON (`goal_reasoning`), FEEDBACK (`provide_feedback`), INSPECT (`registry_query` / `execution_trace` / `resolve_impulse`). The last three replace `docker exec` / `journalctl` / raw `curl` for reading the running substrate. Canonical loop:

```
run_goal_async({ goal })        → dispatchId    (name a repos/<vessel>/src file for a code change)
goal_status({ dispatch_id })    → read `reached`, not `status`
goal_reasoning({ dispatch_id }) → the walk decision-log: why it reached / fell short
provide_feedback({ dispatch_id, verdict, rationale })  → verdict into the oracle corpus
```

**Plain code-change goals route to `feature_compose`.** goal-host routes a goal that names a real `repos/<vessel>/src/…` file (e.g. `run_goal_async({ goal: "edit repos/development-vessel/src/resolvers/gap-to-feature.ts: <change>" })`) through the edit-intent path to `feature_compose`, which drafts + typecheck-verifies + lands a real traced commit via mitosis cutover; this server forwards the goal text unchanged. `reached:true` + a `feature_compose` `selectedTemplateId` + a landed commit means it worked; then read the diff (a change can pass the reach-gate yet not do what was asked). Every `run_goal` / `run_goal_async` dispatch carries `operator:<id>` (default `claude-code-operator`, override `MB_OPERATOR_ID`), which goal-host stamps into the trace tags; `resolve_impulse` adds none.

**Goal dispatch/track contract** (goal-host-vessel, `repos/goal-host-vessel`):
- `POST /run-goal` → `202 { dispatchId, status:"running" }` (async; the goal runs in the background).
- `GET /executions/:dispatchId` → `{ status, executionId, selectedTemplateId, error }` (in-memory, last ~100 dispatches, pruned). `goal_status` polls this, then hydrates the durable trace from activity-api `GET /v2/activities/execution-traces/:executionId`.
- `POST /resolve` (impulse-envelope) → synchronous result; what `run_goal` uses.

## Impulse shapes resolved (HTTP)

Resolver endpoint: `POST /v2/impulses/resolve` — `Authorization: ApiKey <METABOB_API_KEY>`. The shape → tool map lives in docs/SPEC.md § Impulse shapes (HTTP resolver).

## Environment variables

**Minimal setup is a single variable: `METABOB_API_KEY`.** `METABOB_ENDPOINT` (the gateway in the vessel) is optional and **defaults to `https://ide.metabob.com`** — so an API key alone is a valid config. When set, the endpoint is the gateway (identical to `metabob.endpoint` in `~/.metabob/config.json`): a local substrate endpoint derives discovery / analysis / concept-db at port offsets; a remote endpoint derives nothing, and discovery is set explicitly. The remaining variables are advanced overrides — each wins over its derived value only when set explicitly. (Carve-out: if you manually pin a specific endpoint var like `ANALYSIS_API_URL` without `METABOB_ENDPOINT`, the default-gateway derivation stays inert so it can't split-brain your hand-configured routing.)

| Variable | Default | Purpose |
|----------|---------|---------|
| `METABOB_API_KEY` | — | API key — authenticates every analysis request (exchanged for a session token only under `METABOB_STATELESS=true`) and identity-vessel tenant resolution |
| `METABOB_ENDPOINT` | `https://ide.metabob.com` | **Gateway in the vessel** — a local substrate endpoint derives analysis, discovery and concept-db from it; a remote one derives nothing. Env-var mirror of `metabob.endpoint`; pairs with `METABOB_API_KEY` as the canonical minimal config |
| `SESSION_TOKEN` | — | Pre-obtained session token (skips key exchange) |
| `METABOB_STATELESS` | _(unset)_ | Set to `true` to disable sidecar mode: no LocalStore, so `record_finding` stops surfacing locally, the `get_problems` seed cache is empty, and `pull_assigned_work` / `submit_resolution` have no durable queue. Also forces the legacy single-event telemetry path |
| `ANALYSIS_API_URL` | _(derived from a local `METABOB_ENDPOINT`, else `https://ide.metabob.com`)_ | Advanced: analysis API base URL override |
| `IDENTITY_ENDPOINT` | `https://ide.metabob.com/identity` when no discovery is set; else unset (tenant resolution skipped) | Advanced: identity vessel endpoint (tenant resolution) override |
| `WORKSPACE_PATH` | `$PWD` | Default root for `init_workspace` |
| `SESSION_ID` | _(fresh UUID per launch)_ | Session identifier |
| `HEALTH_PORT` | _(ephemeral)_ | Vessel HTTP server port. No fixed default: concurrent instances would collide, and 8000–8999 are substrate container ports (8080 is activity-api; discovery rewrites `127.0.0.1:8xxx` rows to +10000). Warns if set in that range |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `METABOB_STDIO_KEEPALIVE` | _(unset)_ | Set to `1` to survive stdin EOF — headless operation (HTTP resolver + discovery only). Otherwise the process exits on stdin EOF or `SIGHUP`, so an orphaned sidecar does not outlive its MCP client |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |
| `USE_CONNECTION_SLOTS` | `false` | Enable activity-API connection slot management |
| `USER_VESSEL_URL` | `https://ide.metabob.com` | user-vessel endpoint (legacy telemetry target) |
| `METABOB_TELEMETRY` | _(unset)_ | Set to `off` to disable per-tool-call usage telemetry |
| `MB_OPERATOR_ID` | `claude-code-operator` | Operator identity threaded onto goal dispatch (`run_goal` / `run_goal_async`) and folded into `provide_feedback` label notes |
| `DISCOVERY_ENDPOINT` | _(derived)_ | Discovery-vessel base URL; overrides discovery derivation for `registry_query` / `resolve_impulse` (local default `http://127.0.0.1:18100`) |
| `VESSEL_ID` | _(derived)_ | Discovery registration id. Defaults to a stable, unique `metabob-mcp-<hash(apiKey+workspace)>` (distinct instances disambiguate automatically). Set explicitly only for deliberate replica/failover (same value on two instances = one registry row) |
| `VESSEL_PUBLIC_ENDPOINT` | _(unset → no registration)_ | Base URL advertised for inbound HTTP resolves. Required for registration — set it only to an address the row's readers can actually dial (loopback works only within the same network namespace) |
| `METABOB_AGENT_RESOLVER` | _(off)_ | Whether this session offers itself as an agent-resolver (advertises `human_input` so the substrate can dispatch solicited decisions to it). Opt in with `1`/`true`/`on` only where a human is at that terminal; `human_input` already has producers (the human surface is the user's interaction point) |

## Vessel registration (point-and-go)

The substrate's participation requirements take priority over this section's design; [docs/CONFORMANCE.md](docs/CONFORMANCE.md) lists each one and whether the code meets it.

Beyond being an MCP/HTTP client, the process joins a discovery namespace as a
conventional vessel with only `{discovery endpoint, valid key}` — everything else
derives (namespace from the verified key; discovery explicit or from a local gateway;
relay from `GET /bootstrap`, read at use time, never pinned). Registration
fails open: no discovery/key, or an unreachable discovery, degrades to a
client-only process. Registration additionally requires the HTTP server to have
**bound** and an explicit `VESSEL_PUBLIC_ENDPOINT` — a vessel never advertises
an endpoint it doesn't serve, and there is no loopback default (the host's
`127.0.0.1` is not a container's, so such a row is undialable from the
substrate).

- **Disambiguation.** `VESSEL_ID` is stable+unique per instance (above), so
  multiple concurrent instances register distinct rows; the same workspace+key
  across restarts is a stable replica.
- **Transport.** Prefers a libp2p circuit-relay overlay when a relay is
  advertised via `/bootstrap` *and* the optional peer
  `@avigopal/libp2p-federation-transport` is installed (dynamically imported,
  never bundled); otherwise HTTP — the always-works fallback for proxied
  networks. The overlay serves the same resolve handler as the HTTP resolver.
- **Shape-driven advertisement (Law 1).** The advertised shape-set reflects live
  capability: CPG-dependent shapes (`code:cochange_prediction`,
  `code:impact_analysis`, `code:git_change_assignment`) are advertised only once
  a workspace is indexed (`init_workspace`); `mcp:tool_call` and
  `code:analysis_context` are always served.
- **Agent-resolver (cross-session).** When `METABOB_AGENT_RESOLVER=1` (opt-in;
  off by default — the human surface is the user's interaction point), the vessel also advertises `human_input` so a goal-host walk can
  dispatch a solicited decision TO the agent. The task is durably enqueued
  (`~/.metabob/sidecar.db`, keyed by the stable vesselId); the agent drains it
  with `pull_assigned_work` and answers with `submit_resolution`, which delivers
  `solicitationResponse_write` back to unblock the walk. Because the queue and
  undelivered answers persist keyed by the vesselId, a later session in the same
  workspace resumes coordination — pulls still-pending tasks and re-delivers
  answers a prior session couldn't send.

## Telemetry

Every tool dispatch records one fire-and-forget event carrying `tool_name`,
`success`, `duration_ms`, and (on failure) a truncated `error_code`. Two
transports, selected by the resolved analysis endpoint: a single `POST` to
`${USER_VESSEL_URL}/v2/mcp/usage` when it points at `ide.metabob.com` (or
`METABOB_STATELESS=true`), otherwise a `{ session_id, events }` batch to
`${ANALYSIS_API_URL}/v2/events/mcp` every 5s or per 50 events. Authentication
reuses the customer's `METABOB_API_KEY`. user-vessel upserts a per-`api_key_id`
snapshot row keyed by the HMAC-embedded `key_id` returned by identity-vessel's
`/v1/auth/resolve`.

Telemetry is opt-out via `METABOB_TELEMETRY=off` and silently disabled when no
API key is configured. Transport failures buffer in-memory and retry on the
next tool call; on process exit any unsent events are dropped (acceptable for
volume-only usage telemetry — billing is sourced from `/v2/costs`).

## Docs ↔ code links

The link database is `docs/links.json`, maintained by `scripts/doclinks.mjs` (see `docs/DOCLINKS.md`).

- **Hooks do the prompting.** After you edit a file you are told which docs are linked to what you touched;
  at the end of a turn you are stopped once with any linked live docs you have not reviewed. For each: update
  it in the same task if your change affects what it says; if it does not, record that —
  `node scripts/doclinks.mjs reviewed <doc> --why "..."` — rather than editing the doc to silence it.
- **Cite so it can be checked.** In a doc: `<file>.ts@<anchor>` (a `// @anchor name` line above the code, or a
  uniquely named declaration such as `handle`) — **never `<file>.ts:120`**. A doc describing the past pins the
  commit: `<file>.ts:120@<sha>`. In code: name the doc and the section's heading slug — `SPEC §get_problems`,
  `SPEC §impulse-shapes`, `CLAUDE §environment-variables`.
- **Docs are present and timeless.** A doc states the code's intent and its current behaviour, in present
  tense. No change narration in docs or comments ("now", "previously", "no longer", "added in"); history
  belongs in git.
- **After changing citations, anchors or docs:** `node scripts/doclinks.mjs build`, and commit
  `docs/links.json` with the change. `node scripts/doclinks.mjs check` must report 0 errors (`bun test`
  runs it as `tests/unit/doclinks.test.ts`).
- **New doc:** register it in `curated.docs`, mark it `live` if it describes the tree, and add what it
  describes to `curated.covers`. Renaming a heading renames its section id: update the code that cites it.

## Adding a tool

1. Create `src/tools/<tool-name>.ts` — export a `Tool` object, `InputSchema` (Zod), and `handle()` function; its header comment cites `SPEC §<tool_name>`
2. Register in `src/tools/index.ts` — add to `TOOL_REGISTRY`
3. If the tool resolves an impulse shape, add a case in `resolvePointerToTool()` in `src/vessel-server.ts`
4. Add a `### <tool_name>` section to `docs/SPEC.md` with the input schema, the behaviour, and `Handler: src/tools/<tool-name>.ts@handle`; add the file to `curated.covers` in `docs/links.json`; run `node scripts/doclinks.mjs build`

## Dependency diagram

```
Agent (Claude Code / Cursor / custom)
   │ MCP stdio
   ▼
@metabob/mcp  ──────────────────────────────────────────────────────┐
   │ HTTP (session token)          │ in-process                      │ identity-vessel JWT
   ▼                               ▼                                 ▼
ide.metabob.com              cpg-inference-ts              ide.metabob.com/identity
(feedback, usage             (Tree-sitter, GCN,            (tenant resolution,
 telemetry — no file          vector search)                key-issuance heartbeat)
 content)
```

## Related

- [docs/SPEC.md](docs/SPEC.md) — full tool specification
- [docs/DOCLINKS.md](docs/DOCLINKS.md) — the docs ↔ code link database and its checks
- [docs/CONFORMANCE.md](docs/CONFORMANCE.md) — the substrate participation requirements this vessel answers to, and which it meets
- [vendor/cpg-inference](vendor/cpg-inference/) — vendored CPG fork (Tree-sitter parsing, ONNX embedding, vector index)
