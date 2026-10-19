# @metabob/mcp

MCP bridge and local CPG analysis vessel. Exposes Metabob analysis capabilities to AI agents via two protocols:

- **MCP (stdio)** — Claude Code, Cursor, Continue, and other MCP clients
- **HTTP resolver (`127.0.0.1:HEALTH_PORT`, ephemeral by default)** — local callers invoke tools via impulse pointers

**No workspace content leaves the machine.** The server is an agent cockpit plus substrate integration: `init_workspace` reads files into an in-process CPG and nowhere else, nothing watches the workspace or submits files, excerpts or file lists for analysis, and so there is no server-side analysis — problems are what agents record (`record_finding`). The server sends no usage telemetry.

**One configuration: the attachment.** An API key and an endpoint, nothing defaulted (§ Environment variables).
Every substrate request carries `Authorization: ApiKey <METABOB_API_KEY>`. The server is a **client** of the
substrate: it makes no discovery registration or heartbeat, runs no libp2p node, and binds its HTTP
resolver to `127.0.0.1` ([docs/CONFORMANCE.md](docs/CONFORMANCE.md) C1, C2, C11). The key is proven before
any other keyed call: `src/attachment.ts@attach` reads the identity endpoint from discovery's `GET /bootstrap`
(or an explicit `IDENTITY_ENDPOINT`) and runs the org check, `POST /v1/auth/resolve` → `orgId`; until it
passes, every substrate tool answers with one line naming the cause (`key_rejected`, `identity_unreachable`,
…) and local tools work as usual (docs/SPEC.md § Attachment).

## Quick reference

```bash
bun run dev                         # start with watch mode
bun run typecheck                   # tsc --noEmit
bun test                            # run tests
bun run build                       # compile src/ → dist/cli.js (required for npm link)
bun src/cli.ts attach --check       # attach once and print each hop: proxy, TLS, /bootstrap, identity, org check, one resolve
npm link                            # register metabob-mcp bin globally for local testing
bash scripts/git-hooks/install.sh   # install pre-commit + pre-push hooks
lab/lab.sh up|check|cycle|down|destroy   # two-node lab (hub :24100, spoke :25100): bring up, prove it serves the MCP, tear down (lab/README.md)
node scripts/doclinks.mjs check     # docs ↔ code links: must report 0 errors
```

## Branching

Branch off `dev` and open PRs into `dev`; `main` advances only by a version-bumped checkpoint whose commits are already on `dev`, never by direct feature work. The `pre-push` hook enforces both conditions — see `scripts/git-hooks/README.md` § Branch policy for the exact rules and the emergency override. Run `bash scripts/git-hooks/install.sh` once per clone to activate.

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — the one "not attached" message, starts the attachment, MCP server (with the substrate-tool gate), loopback resolver, shutdown |
| `src/attachment.ts` | The attachment: `{discovery, key}` → `/bootstrap` → identity selection → org check; its typed state for `/health` and `doctor`; `resolve(pointer)` through discovery `POST /resolve` — the one ingress every substrate tool takes, with named failures (`no_producer`, `producer_timeout`, …), per-family timeouts and read retries; the gate keyed calls pass |
| `src/api-client.ts` | The context handed to every tool handler; carries no substrate address and makes no requests |
| `src/config.ts` | Config loading: the installer's `SUBSTRATE_*` names, env, then the config file (lookup order below); the discovery derivation and whether discovery was derived (H1); `unattachedMessage` |
| `src/net.ts` | The one outbound HTTP path: proxy selection per request (`HTTP(S)_PROXY`, `NO_PROXY`, loopback always direct), trust (bundled + OS store + `NODE_EXTRA_CA_CERTS`), the connect budget, transient retries on reads, and the named network causes (`proxy_auth_required(NTLM)`, `tls_intercepted(issuer)`, `connect_timeout`, …). Identical under Bun and Node (docs/SPEC.md § Network) |
| `src/os-proxy.ts` | Reads the OS proxy / PAC settings (scutil, registry, gsettings) to name them when a direct connection fails; never applies them |
| `src/attach-check.ts` | `metabob-mcp attach --check`: the attachment once, hop by hop, with the named cause; exit 0 when attached |
| `src/auth-service.ts` | Identity-vessel org check (`POST /v1/auth/resolve`, classified) and the key-issuance heartbeat, against the attachment's identity |
| `src/vessel-server.ts` | Hono HTTP server on `127.0.0.1` — `/health` (with the attachment state), `/v2/capabilities`, `POST /v2/impulses/resolve`, for local callers |
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
| `mark_complete` | Local + Substrate | Endorse (fixed) or discard (false positive) an `agf_*` or `concept_*` id; any other id is refused, since there are no backend detections. For agent findings: endorse marks the LocalStore seed stale, discard deletes the **local seed only** (the org-wide `code_finding` concept is never retracted), a `finding_verdict` concept is best-effort recorded to concept-db, and — closing the relevance loop — the verdict is folded directly into the finding concept's relevance via a usage signal (endorse→`success`, discard→`failure`) when the seed carries a linked `concept:` id. Accepts a `concept_*` id too (the form cross-agent recall hands you) and resolves it to its `agf_*` seed via `LocalStore.getSeedByConceptRef`; with no local seed the verdict is written from the recalled concept itself (still keyed on the finding's `agf_*` id) and the output states that nothing local was retired. Both paths stamp the verdict with `reviewed_by: <vesselId>` + `session: <sessionId>` and a separate `origin: local` / `origin: remote` provenance line — author and locality are never folded into one key. |
| `get_metrics` | **Local** | Open findings in the local store by severity, source and category, plus the local CPG size; makes no request and states that there is no server-side analysis |
| `assign_git_changes` | **Local** | Maps changed files → CPG components + co-change predictions + local-store findings in those files |
| `get_analysis_context` | Local + Substrate | Snapshot of CPG stats + open problems from the local store + co-change predictions + compact top-5 recall of other agents' recorded findings for this codebase |
| `run_goal` | Substrate | Dispatch a goal and **wait** for it: `goalDispatchAsync`, then short `goalWalkState` polls until it leaves `running` or the polling deadline `RUN_GOAL_TIMEOUT_MS` (default 290 s) passes — no request is held open; past the deadline the goal keeps running and the reply carries its `dispatchId`. Short, one-shot goals. |
| `run_goal_async` | Substrate | Dispatch a goal **asynchronously** (shape `goalDispatchAsync`); returns a `dispatchId` immediately. Long goals / fire-and-forget. |
| `goal_status` | Substrate | Poll a `dispatchId` → the honest **`reached`** verdict (primary line), then `status`/executionId/template + hydrated trace (state-space signature, produced shapes, failure mode, Thompson α/β). Read `reached`, not `status` — `completed`≠reached, and a satisfier reach can be `status:"failed"` yet `reached:true`. |
| `goal_reasoning` | Substrate | The "reason plane": reconstruct the goal-host walk's decision-log for a `dispatchId` — ordered per-task walk steps (resolver + tier, shapes consumed → produced, success, failure_mode), reach verdict, Thompson α/β. Richer than `goal_status`: it renders the goal-host `walkLog` whenever the dispatch record has one, and says the decision-log is unavailable when there is neither a `walkLog` nor trace tasks (typically a direct vessel resolve). |
| `provide_feedback` | Substrate | The "feedback plane": record an operator verdict (`reached`/`not_reached`/`partial` + rationale + confidence) on a `dispatchId` → records an `automated` label in the substrate's oracle corpus (`goal_verification_labels`): an agent's verdict, which goal-host does not treat as ground truth (only `human` labels overwrite `reached`), consumed by offline audit. Reads goal/executionId/template from goal-host's dispatch record (`goalWalkState`; `goal` may be supplied) and writes `goal_verification_label_write`; a pruned (404) or still-running dispatch cannot be labelled. Pair with `goal_reasoning`: inspect the walk, then endorse or correct it. Measured feedback, not advice. Folds the operator id into the label notes. |
| `registry_query` | Substrate | Inspect discovery-vessel's registry without host access, through discovery's own shapes. `mode:"shapes"` lists the advertised shape vocabulary — the union of `vesselRegistry`'s vessel shapes (optional `shape` substring filter, applied client-side); `mode:"vessels"` (requires `shape`) lists vessels advertising a shape (vesselId, endpoint, protocol, resolve_endpoint) via `vesselCapability`. |
| `execution_trace` | Substrate | Read a durable execution trace by `execution_id` through the `activityExecutionTrace` shape (activity-api's resolver, reached through discovery) — status, activity_template_id, composition_chain, load-bearing tags (`state_signature:`, `reached:`, `completion_shapes:`, `operator:`), and per-task sequence (`#N ✓/✗ resolver/tier inShapes → outShapes` + failure_mode). `goal_reasoning` renders the same trace for a dispatch. 404 (satisfier-only reach) handled gracefully. |
| `resolve_impulse` | Substrate | ADVANCED escape hatch: a thin passthrough of the attachment's `resolve()` for ANY shape (memoryNote, feature_compose, `*_write`, …) — `{ pointer }` to discovery `POST /resolve`, sent once — instead of a raw `curl`. Prefer the dedicated tools when they fit. |
| `concept_*` | Substrate | concept-db graph: `concept_search` / `_neighbors` / `_usage_stats` / `_sequence` / `_link` / `_create` / `_record_usage`. See docs/SPEC.md § Concept graph tools. |
| `concept_record_usage` | Substrate | The direct write into concept-db's **relevance** model — the `conceptUsage_write` shape. Attribute an outcome to a concept you used: `success` credits it (raises relevance), `failure`/`neutral` grow the load count without credit. concept-db folds it into the Bayesian posterior mean `(times_succeeded+1)/(times_loaded+2)`. Reads through `conceptSearch` / `conceptGraph` record no load, so this is how a concept the agent relied on gets credit. |
| `pull_assigned_work` | Resolver | Claim `human_input` tasks queued on this machine (by a local caller of the loopback resolver). Durable + keyed by the stable vesselId. The substrate dispatches nothing to a client-only session, so with the queue empty it reports that no task can arrive. |
| `submit_resolution` | Resolver | Answer a pulled task (`{task_id, outcome, answer?}`). Recorded durably, then delivered to goal-host as `solicitationResponse_write` to unblock its walk; retried on a later session if the substrate was unreachable. An unknown `task_id` is reported, with the note that nothing is dispatched to this session. |

**Substrate tools** (`run_goal*`, `goal_status`, `goal_reasoning`, `provide_feedback`, `registry_query`, `execution_trace`, `resolve_impulse`, `concept_*` incl. `concept_record_usage`, and the substrate half of `record_finding` / `get_problems` / `get_analysis_context` / `mark_complete` / `submit_resolution`) reach the substrate through **one ingress**: each operation is a shape resolved through discovery `POST /resolve` (`src/attachment.ts@attachment-resolve`), which picks the shape's producer — goal-host (`goalDispatchAsync`, `goalWalkState`, `solicitationResponse_write`), activity-api (`activityExecutionTrace`, `goal_verification_label_write`), concept-db (`conceptSearch`, `conceptGraph`, `concept_create_write`, …) or discovery itself (`vesselRegistry`, `vesselCapability`) — and forwards the pointer with the key. No service URL is configured, derived or discovered for a call; the one exception is `concept_usage_stats`'s recent rows, which no shape serves (CONFORMANCE §c11). Discovery's own failures are one named line (`no_producer(shape)`, `producer_timeout(shape, ms)`, …), and so is the network's (`proxy_auth_required(NTLM)`, `tls_intercepted(issuer)`, `connect_timeout(host:port)`, …: docs/SPEC.md § Network); every request is capped below 60 s, and reads cut at a producer's timeout are retried. Config resolution is directory-aware, like git: `SUBSTRATE_CONFIG_PATH` → `METABOB_CONFIG_PATH` → `./.substrate/config.json` → `./.metabob/config.json` (launch directory; lets a project pin its own backend) → `~/.substrate/config.json` (what the installer writes) → `~/.metabob/config.json`. A local substrate endpoint (`http://127.0.0.1:18080`, what the installer writes) needs only `metabob.apiKey` + `metabob.endpoint` — it derives `DISCOVERY_ENDPOINT=…:18100` (census class H1 interim debt, warned about once at startup); a remote endpoint derives **nothing**, so a remote substrate needs an explicit `DISCOVERY_ENDPOINT` / `metabob.discoveryEndpoint`. An explicit `METABOB_ENDPOINT` takes only the credentials from a config file, never its endpoints, so the two can't split across substrates.

**The surface is a complete operator cockpit — no host access needed.** Three planes + a coverage set: ACT (`run_goal*`), TRACK (`goal_status`), REASON (`goal_reasoning`), FEEDBACK (`provide_feedback`), INSPECT (`registry_query` / `execution_trace` / `resolve_impulse`). The last three replace `docker exec` / `journalctl` / raw `curl` for reading the running substrate. Canonical loop:

```
run_goal_async({ goal })        → dispatchId    (name a repos/<vessel>/src file for a code change)
goal_status({ dispatch_id })    → read `reached`, not `status`
goal_reasoning({ dispatch_id }) → the walk decision-log: why it reached / fell short
provide_feedback({ dispatch_id, verdict, rationale })  → verdict into the oracle corpus
```

**Plain code-change goals route to `feature_compose`.** goal-host routes a goal that names a real `repos/<vessel>/src/…` file (e.g. `run_goal_async({ goal: "edit repos/development-vessel/src/resolvers/gap-to-feature.ts: <change>" })`) through the edit-intent path to `feature_compose`, which drafts + typecheck-verifies + lands a real traced commit via mitosis cutover; this server forwards the goal text unchanged. `reached:true` + a `feature_compose` `selectedTemplateId` + a landed commit means it worked; then read the diff (a change can pass the reach-gate yet not do what was asked). Every `run_goal` / `run_goal_async` dispatch carries `operator:<id>` (default `claude-code-operator`, override `MB_OPERATOR_ID`), which goal-host stamps into the trace tags; `resolve_impulse` adds none.

**Goal dispatch/track contract** (goal-host-vessel's shapes, each resolved through discovery `POST /resolve`):
- `goalDispatchAsync` → `202 { dispatchId, status:"running" }` (async; the goal runs in the background). `run_goal_async` and `run_goal` dispatch with it.
- `goalWalkState { dispatchId }` → `{ resolved, body:{ status, reached, executionId, selectedTemplateId, error, walkLog (last 60), … } }` (in-memory, last ~100 dispatches, pruned). `goal_status` reads this, then hydrates the durable trace through the `activityExecutionTrace` shape; `run_goal` polls it.
- No call holds a request open for a goal: discovery cuts goal-host's resolves at 60 s.

## Impulse shapes resolved (HTTP)

Resolver endpoint: `POST /v2/impulses/resolve` on `127.0.0.1` — `Authorization: ApiKey <METABOB_API_KEY>`, local callers only; nothing advertises it. The shape → tool map lives in docs/SPEC.md § Impulse shapes (HTTP resolver).

## Environment variables

**The configuration is two values: `METABOB_API_KEY` and `METABOB_ENDPOINT`** (or `metabob.apiKey` and
`metabob.endpoint` in a config file — the installer writes both into `~/.substrate/config.json`, which
`~/.metabob/config.json` links to; the installer's env names `SUBSTRATE_API_KEY` / `SUBSTRATE_ENDPOINT`
are accepted too). Neither has a default. Proxy and trust are never configuration: they come from the
environment (`HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`) and the OS trust store. When the server
does not attach, run `metabob-mcp attach --check` first. With either missing the server starts with local
tools only and logs one message naming the missing input and the config lookup order
(`src/config.ts@unattachedMessage`). A local endpoint derives discovery at its port offset; a remote
endpoint derives nothing, and discovery is set explicitly. No other service URL is configuration: every
substrate call resolves a shape through discovery. The remaining variables are advanced overrides — each
wins over its derived value only when set explicitly.

| Variable | Default | Purpose |
|----------|---------|---------|
| `METABOB_API_KEY` | — | API key — sent as `Authorization: ApiKey` on every substrate request; validates calls to the loopback resolver |
| `METABOB_ENDPOINT` | — | Substrate endpoint. A local `http://…:18080` derives discovery `:18100`; a remote one derives nothing. Env-var mirror of `metabob.endpoint` |
| `SUBSTRATE_API_KEY`, `SUBSTRATE_ENDPOINT` | — | The installer's names for the key and endpoint; fill `METABOB_*` when unset. When both are set and differ, `METABOB_*` wins, with one warning |
| `SUBSTRATE_CONFIG_PATH`, `METABOB_CONFIG_PATH` | — | Config file to read (in that order) instead of the lookup `./.substrate` → `./.metabob` → `~/.substrate` → `~/.metabob` (`config.json` in each) |
| `HTTPS_PROXY`, `HTTP_PROXY` | — | HTTP CONNECT proxy, chosen per request: https uses `HTTPS_PROXY` (falling back to `HTTP_PROXY`), http uses `HTTP_PROXY`; lowercase names win. Basic credentials go in the URL and are redacted everywhere they are reported. PAC / WPAD is not evaluated: set the proxy it names |
| `NO_PROXY` | — | Hosts that go direct (`*`, host and subdomains, `host:port`, IPv4 CIDR). Whenever a proxy is set, `localhost`, `127.0.0.1` and `::1` are added, and every loopback host goes direct |
| `NODE_EXTRA_CA_CERTS` | — | Extra trusted roots (PEM), on top of the bundled roots and the OS store; read by the server itself, so it applies under Bun too |
| `METABOB_CONNECT_TIMEOUT_MS` | `5000` | Connect budget (TCP connect, proxy `CONNECT`, TLS handshake), separate from each call's response budget |
| `METABOB_NO_SYSTEM_CA` | _(unset)_ | `1` skips the OS trust store (also `--no-system-ca`) |
| `DISCOVERY_ENDPOINT` | _(derived)_ | The anchor: discovery-vessel base URL (also `metabob.discoveryEndpoint`, the preferred form). Required with a remote endpoint; derived from a local one with a WARN naming census class H1 |
| `IDENTITY_ENDPOINT` | _(from `/bootstrap`)_ | Advanced: identity vessel for the org check, overriding the `identity_endpoint` discovery's `/bootstrap` advertises |
| `RUN_GOAL_TIMEOUT_MS` | `290000` | `run_goal`'s polling deadline: how long it waits for a dispatched goal before handing back its `dispatchId` |
| `RUN_GOAL_POLL_MS` | `2000` | Pause before `run_goal`'s first three `goalWalkState` polls; later pauses double up to `RUN_GOAL_POLL_MAX_MS` |
| `RUN_GOAL_POLL_MAX_MS` | `15000` | Longest pause between `run_goal`'s `goalWalkState` polls (each read makes goal-host re-read the execution's labels) |
| `RESOLVE_IMPULSE_TIMEOUT_MS` | `30000` | `resolve_impulse`'s request cap (never above 60 s) |
| `WORKSPACE_PATH` | `$PWD` | Default root for `init_workspace` |
| `SESSION_ID` | _(fresh UUID per launch)_ | Session identifier |
| `HEALTH_PORT` | _(ephemeral)_ | Port of the loopback HTTP resolver. No fixed default: concurrent instances would collide, and 8000–8999 are substrate container ports (8080 is activity-api). Warns if set in that range |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `METABOB_STDIO_KEEPALIVE` | _(unset)_ | Set to `1` to survive stdin EOF — headless operation (the loopback HTTP resolver only). Otherwise the process exits on stdin EOF or `SIGHUP`, so an orphaned server does not outlive its MCP client |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |
| `METABOB_TOOLS` | _(unset → all)_ | Comma-separated tool allowlist, enforced on stdio and on the loopback resolver |
| `MB_OPERATOR_ID` | `claude-code-operator` | Operator identity threaded onto goal dispatch (`run_goal` / `run_goal_async`) and folded into `provide_feedback` label notes |
| `VESSEL_ID` | _(derived)_ | The coordination identity: keys the local agent-task queue and is the `recorded_by` / `reviewed_by` author of findings and verdicts. Defaults to a stable `metabob-mcp-<hash(apiKey+workspace)>`. Never registered anywhere |

## Attachment (client-only)

The substrate's participation requirements take priority over this vessel's design; [docs/CONFORMANCE.md](docs/CONFORMANCE.md) lists each one and whether the code meets it.

The process is a client of the substrate. Inbound resolves are offered only after a reachability probe
from an outside vantage, and none exists for host vessels, so it offers nothing:

- **No registration, no heartbeat.** It writes no discovery row under any configuration, so it has no
  endpoint to advertise and no row to keep alive or leave stale.
- **No overlay node.** It runs no libp2p peer; it reaches the substrate as a client of one ingress,
  discovery `POST /resolve`.
- **Loopback resolver.** `/health`, `/v2/capabilities` and `POST /v2/impulses/resolve` bind `127.0.0.1`
  for local callers. `/health` reports the attachment state: anchor and its source, `/bootstrap` result,
  identity (chosen, advertised, tried), the org check (`orgId`), the named cause, advertised: none, and
  the network diagnosis (proxy in use, redacted; the network cause; the TLS issuer; the last outcome per
  producer family).
- **Agent-task queue.** A `human_input` impulse that reaches the loopback resolver is durably enqueued
  (`~/.metabob/sidecar.db`, keyed by the stable vesselId); the agent drains it with `pull_assigned_work`
  and answers with `submit_resolution`, which delivers `solicitationResponse_write` to goal-host. Undelivered
  answers are re-sent by a later session in the same workspace. The substrate itself dispatches nothing here.

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
@metabob/mcp ── client only: no registration, no overlay node ──────────────┐
   │ HTTP, Authorization: ApiKey          │ in-process                       │ loopback only
   ▼                                      ▼                                  ▼
discovery POST /resolve              cpg-inference-ts                 127.0.0.1 resolver
(the one ingress: forwards each      (Tree-sitter, GCN,               (/health, /v2/capabilities,
 shape to goal-host, concept-db,     vector search)                   /v2/impulses/resolve)
 activity-api; identity from
 /bootstrap, org check first)
```

## Related

- [docs/SPEC.md](docs/SPEC.md) — full tool specification
- [docs/DOCLINKS.md](docs/DOCLINKS.md) — the docs ↔ code link database and its checks
- [docs/CONFORMANCE.md](docs/CONFORMANCE.md) — the substrate participation requirements this vessel answers to, and which it meets
- [vendor/cpg-inference](vendor/cpg-inference/) — vendored CPG fork (Tree-sitter parsing, ONNX embedding, vector index)
