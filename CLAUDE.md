# metabob-mcp

MCP bridge and local CPG analysis vessel. Exposes Metabob analysis capabilities to AI agents via two protocols simultaneously:

- **MCP (stdio)** — Claude Code, Cursor, Continue, and other MCP clients use this directly
- **HTTP resolver (port 8080)** — the activity system invokes tools via impulse pointers

Complements `metabob-analysis-api`: the analysis-api owns persistent problem storage and server-side CPG; this vessel owns the agent interface and local in-process CPG inference (co-change prediction, impact traversal).

## Quick reference

```bash
bun run dev          # start MCP + HTTP vessel server
bun run typecheck    # tsc --noEmit
bun test             # run tests
bash scripts/git-hooks/install.sh   # install pre-commit hook
```

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — wires MCP server + VesselServer, handles auth and lifecycle |
| `src/vessel-server.ts` | Hono HTTP server — `/health`, `/ready`, `/v2/capabilities`, `POST /v2/impulses/resolve` |
| `src/local-index.ts` | Singleton `LocalIndex` wrapping `CoChangePredictor` from `cpg-inference-ts` |
| `src/api-client.ts` | HTTP client to metabob-analysis-api — auth, retries, circuit breaker |
| `src/tools/index.ts` | Tool registry — maps tool names to handlers |
| `.minibob/vessel.json` | Vessel descriptor — shapes, resolver endpoint, tools, dev config |
| `docs/SPEC.md` | Full tool specification with input/output schemas |

## Tools

| Tool | Tier | Key behaviour |
|------|------|--------------|
| `init_workspace` | Local + API | Parses files into CPG via `cpg-inference-ts`; call before `predict_cochanges` / `analyze_impact` |
| `get_problems` | API | Fetches problems from analysis-api ranked by impact |
| `search_codebase` | API | Semantic search, component-centric results |
| `predict_cochanges` | **Local** | GCN embeddings + vector search — no API call; requires `init_workspace` |
| `analyze_impact` | **Local** + API | BFS over local CPG; API augmentation is best-effort |
| `annotate_component` | API | Persists to analysis-api |
| `mark_complete` | API | Marks problem resolved |
| `generate_spec` | API | Implementation plan from natural language goal |
| `get_metrics` | API | Project health stats |
| `activity` | API (Activity) | Discriminated action: `resolve_impulse \| run_goal \| get_recommendations \| submit_trace` |

## Impulse shapes resolved (HTTP)

| Shape | Maps to | Notes |
|-------|---------|-------|
| `mcp:tool_call` | any tool by name | `pointer.tool` + `pointer.input` |
| `code:cochange_prediction` | `predict_cochanges` | requires prior `init_workspace` |
| `code:impact_analysis` | `analyze_impact` | requires prior `init_workspace` |

Resolver endpoint: `POST /v2/impulses/resolve` — `Authorization: ApiKey <METABOB_API_KEY>`

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANALYSIS_API_URL` | `http://localhost:8081` | metabob-analysis-api base URL |
| `ACTIVITY_API_URL` | `$ANALYSIS_API_URL` | Activity API (if separate) |
| `METABOB_API_KEY` | — | API key — authenticates both outgoing API calls and incoming resolver requests |
| `JWT_TOKEN` | — | Direct JWT (advanced; bypasses key exchange) |
| `SESSION_ID` | `default-session` | Session identifier |
| `WORKSPACE_PATH` | `$PWD` | Default root for `init_workspace` |
| `HEALTH_PORT` | `8080` | Vessel HTTP server port |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |

## Adding a tool

1. Create `src/tools/<tool-name>.ts` — export `Tool` object, `InputSchema` (Zod), and `handle()` function
2. Register in `src/tools/index.ts` — add entry to `TOOL_REGISTRY`
3. If the tool resolves an impulse shape, add a case in `resolvePointerToTool()` in `src/vessel-server.ts`
4. Add the tool to `.minibob/vessel.json` `tools[]`
5. Update `docs/SPEC.md` with input/output schema

## Dependency diagram

```
Agent (Claude Code / Cursor)
   │ stdio
   ▼
metabob-mcp (this vessel)
   │ HTTP          │ in-process
   ▼               ▼
metabob-        cpg-inference-ts
analysis-api    (local CPG + GCN)
   │
   ▼
identity-vessel  SurrealDB  Redis
```

## Related

- [docs/SPEC.md](docs/SPEC.md) — full tool specification
- [metabob-analysis-api](../metabob-analysis-api/) — server-side analysis and persistent storage
- [cpg-inference-ts](../cpg-inference-ts/) — local CPG library
- [Root CLAUDE.md](../../CLAUDE.md)
