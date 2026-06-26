# @metabob/mcp

MCP bridge and local CPG analysis vessel. Exposes Metabob analysis capabilities to AI agents via two protocols:

- **MCP (stdio)** — Claude Code, Cursor, Continue, and other MCP clients
- **HTTP resolver (port 8080)** — activity system invokes tools via impulse pointers

Auth: `METABOB_API_KEY` is exchanged for an opaque session token with `ide.metabob.com` on startup. The same key also resolves a tenant JWT from `identity.metabob.com` (used for the HTTP impulse resolver).

## Quick reference

```bash
bun run dev                         # start with watch mode
bun run typecheck                   # tsc --noEmit
bun test                            # run tests
bun run build                       # compile src/ → dist/cli.js (required for npm link)
npm link                            # register metabob-mcp bin globally for local testing
bash scripts/git-hooks/install.sh   # install pre-commit hook
```

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — auth lifecycle, MCP server, refresh timers, shutdown |
| `src/api-client.ts` | HTTP client to `ide.metabob.com` — session auth, file submission, analysis fetch |
| `src/auth-service.ts` | Identity-vessel auth — tenant resolution, JWT refresh, key-issuance heartbeat |
| `src/vessel-server.ts` | Hono HTTP server — `/health`, `/v2/capabilities`, `POST /v2/impulses/resolve` |
| `src/local-index.ts` | Singleton `LocalIndex` wrapping `CoChangePredictor` from `cpg-inference-ts` |
| `src/tools/index.ts` | Tool registry — maps tool names to handlers |
| `docs/SPEC.md` | Full tool specification with input/output schemas |

## Tools

| Tool | Tier | Key behaviour |
|------|------|--------------|
| `init_workspace` | Local + API | Parses workspace into CPG; submits relevance-ranked batch to `ide.metabob.com` |
| `get_problems` | API | `GET /analysis` — problems ranked by severity |
| `search_codebase` | Local + API | Keyword search over CPG nodes and analysis results |
| `predict_cochanges` | **Local** | GCN embeddings + vector search — no API call; needs `init_workspace` |
| `analyze_impact` | **Local** | BFS over local CPG; shows affected components by depth |
| `annotate_component` | API | `POST /explain` or `POST /recommend` for a problem ID |
| `mark_complete` | API | `POST /feedback/detection` — endorse (fixed) or discard (false positive) |
| `get_metrics` | API | Parallel fetch of `/metrics`, `/session/stats`, `/analysis` |
| `assign_git_changes` | Local + API | Maps changed files → CPG components + co-change predictions |
| `get_analysis_context` | Local + API | Snapshot of CPG stats + open problems + co-change predictions |
| `run_goal` | Substrate | Dispatch a goal **synchronously** via goal-host `/resolve` (impulse shape `goal_execution`); blocks ~290s. Short, one-shot goals. |
| `run_goal_async` | Substrate | Dispatch a goal **asynchronously** via goal-host `POST /run-goal`; returns a `dispatchId` immediately. Long goals / fire-and-forget. |
| `goal_status` | Substrate | Poll a `dispatchId` → live status + hydrated trace (state-space signature, produced shapes, failure mode, Thompson α/β). `completed` ≠ reached. |
| `concept_*` | Substrate | concept-db graph: `concept_search` / `_neighbors` / `_usage_stats` / `_sequence` / `_link` / `_create`. See the `metabob-substrate` skill. |

**Substrate tools** (`run_goal*`, `goal_status`, `concept_*`) discover their target vessel through discovery-vessel (`vesselCapability` shape) and host-remap the internal port, rather than assuming a fixed sibling URL. They require `~/.metabob/config.json` to point `metabob.endpoint` at the local substrate (`http://localhost:18080`, which auto-derives `DISCOVERY_ENDPOINT=…:18100`) plus a valid `metabob.apiKey`. Explicit `GOAL_HOST_VESSEL_URL` / `CONCEPT_DB_URL` / `DISCOVERY_ENDPOINT` override discovery.

**Goal dispatch/track contract** (goal-host-vessel, `repos/goal-host-vessel`):
- `POST /run-goal` → `202 { dispatchId, status:"running" }` (async; the goal runs in the background).
- `GET /executions/:dispatchId` → `{ status, executionId, selectedTemplateId, error }` (in-memory, last ~100 dispatches, pruned). `goal_status` polls this, then hydrates the durable trace from activity-api `GET /v2/activities/execution-traces/:executionId`.
- `POST /resolve` (impulse-envelope) → synchronous result; what `run_goal` uses.

## Impulse shapes resolved (HTTP)

| Shape | Maps to | Notes |
|-------|---------|-------|
| `mcp:tool_call` | any tool by name | `pointer.tool` + `pointer.input` |
| `code:cochange_prediction` | `predict_cochanges` | requires prior `init_workspace` |
| `code:impact_analysis` | `analyze_impact` | requires prior `init_workspace` |
| `code:git_change_assignment` | `assign_git_changes` | requires prior `init_workspace` |
| `code:analysis_context` | `get_analysis_context` | — |

Resolver endpoint: `POST /v2/impulses/resolve` — `Authorization: ApiKey <METABOB_API_KEY>`

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `METABOB_API_KEY` | — | API key — session token exchange with `ide.metabob.com` + identity-vessel |
| `SESSION_TOKEN` | — | Pre-obtained session token (skips key exchange) |
| `ANALYSIS_API_URL` | `https://ide.metabob.com` | Analysis API base URL (default) |
| `IDENTITY_ENDPOINT` | `https://identity.metabob.com` | Identity vessel endpoint (tenant resolution) |
| `WORKSPACE_PATH` | `$PWD` | Default root for `init_workspace` |
| `SESSION_ID` | `default-session` | Session identifier |
| `HEALTH_PORT` | `8080` | Vessel HTTP server port |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |
| `USE_CONNECTION_SLOTS` | `false` | Enable activity-API connection slot management |
| `USER_VESSEL_URL` | `https://user.metabob.com` | user-vessel endpoint (telemetry target) |
| `METABOB_TELEMETRY` | _(unset)_ | Set to `off` to disable per-tool-call usage telemetry |

## Telemetry

Every tool dispatch fires one fire-and-forget `POST` to
`${USER_VESSEL_URL}/v2/mcp/usage` recording `tool_name`, `success`,
`duration_ms`, and (on failure) a truncated `error_code`. Authentication
reuses the customer's `METABOB_API_KEY`. user-vessel upserts a per-`api_key_id`
snapshot row keyed by the HMAC-embedded `key_id` returned by identity-vessel's
`/v1/auth/resolve`.

Telemetry is opt-out via `METABOB_TELEMETRY=off` and silently disabled when no
API key is configured. Transport failures buffer in-memory and retry on the
next tool call; on process exit any unsent events are dropped (acceptable for
volume-only usage telemetry — billing is sourced from `/v2/costs`). See
`openspec/changes/2026-05-21-mcp-usage-telemetry/` for the contract.

## Adding a tool

1. Create `src/tools/<tool-name>.ts` — export a `Tool` object, `InputSchema` (Zod), and `handle()` function
2. Register in `src/tools/index.ts` — add to `TOOL_REGISTRY`
3. If the tool resolves an impulse shape, add a case in `resolvePointerToTool()` in `src/vessel-server.ts`
4. Update `docs/SPEC.md` with the input/output schema

## Dependency diagram

```
Agent (Claude Code / Cursor / custom)
   │ MCP stdio
   ▼
@metabob/mcp  ──────────────────────────────────────────────────────┐
   │ HTTP (session token)          │ in-process                      │ identity-vessel JWT
   ▼                               ▼                                 ▼
ide.metabob.com              cpg-inference-ts              identity.metabob.com
(file submit, analysis,      (Tree-sitter, GCN,            (tenant resolution,
 explain, recommend,          vector search)                key-issuance heartbeat)
 feedback)
```

## Related

- [docs/SPEC.md](docs/SPEC.md) — full tool specification
- [cpg-inference-ts](../cpg-inference-ts/) — local CPG library
- [Root CLAUDE.md](../../CLAUDE.md)
