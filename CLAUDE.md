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
bun run test                        # run tests (preflight, then a 30 s per-test limit, as CI uses)
bun run build                       # compile src/ → dist/cli.js (required for npm link)
bun src/cli.ts attach --check       # attach once and print each hop: proxy, TLS, /bootstrap, identity, org check, one resolve
bun src/cli.ts task pull --origin <url> [--kinds <k,…>]  # a cell's entrypoint: claim a ledger task (of those kinds), write /task, clone /work (docs/SPEC.md § task pull)
bun src/cli.ts finding close --commits-from <file>  # after a push: close findings the cell's own commits name (Fixes-Finding:) once merged (§ finding close)
npm link                            # register metabob-mcp bin globally for local testing
bash scripts/git-hooks/install.sh   # install pre-commit + pre-push hooks
lab/lab.sh up|check|cycle|down|destroy   # two-node lab (hub :24100, spoke :25100): bring up, prove it serves the MCP, tear down (lab/README.md)
node scripts/doclinks.mjs check     # docs ↔ code links: must report 0 errors
node scripts/build-plugins.mjs      # regenerate both plugin bundles from their source (--check: fail on drift)
```

## Branching

Branch off `dev` and open PRs into `dev`; `main` advances only by the release workflow (`.github/workflows/release.yml`), which publishes a tagged release commit already on `dev` and then fast-forwards `main` to it, so `main` never pins a version npm lacks (docs/PUBLISHING.md § Workflow). The `pre-push` hook refuses pushes that add commits to `main` and checks `v*` tags — see `scripts/git-hooks/README.md` § Branch policy for the exact rules and the emergency override. Run `bash scripts/git-hooks/install.sh` once per clone to activate.

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — the one "not attached" message, starts the attachment, MCP server (with the substrate-tool gate), loopback resolver, shutdown |
| `src/attachment.ts` | The attachment: `{discovery, key}` → `/bootstrap` → identity selection → org check, retried with backoff (and at once on a substrate tool call) after a transient failure, with readers seeing the last settled attempt while a retry runs; its typed state for `/health` and `doctor`; `resolve(pointer)` through discovery `POST /resolve` — the one ingress every substrate tool takes, with named failures (`no_producer`, `producer_timeout`, …), per-family timeouts and read retries; the gate keyed calls pass |
| `src/api-client.ts` | The context handed to every tool handler; carries no substrate address and makes no requests |
| `src/config.ts` | Config loading: the installer's `SUBSTRATE_*` names, env, then the config file (lookup order below); the discovery derivation and whether discovery was derived (H1); `unattachedMessage` |
| `src/net.ts` | The one outbound HTTP path: proxy selection per request (`HTTP(S)_PROXY`, `NO_PROXY`, loopback always direct), trust (bundled + OS store + `NODE_EXTRA_CA_CERTS`), the connect budget, transient retries on reads, and the named network causes (`proxy_auth_required(NTLM)`, `tls_intercepted(issuer)`, `connect_timeout`, …). Identical under Bun and Node (docs/SPEC.md § Network) |
| `src/outgoing-guard.ts` | The outgoing-text guard every string of a sending tool passes before it runs (stdio and loopback): a known secret (the key, secret-named values from the environment and the workspace's and user's config files, read locally) or a credential pattern refuses the call without repeating it; a home path is redacted in prose and refused where the substrate acts on it; each field has a size cap; the tool-call log shows argument names and sizes only; and a backstop over every write's pointer at the egress refuses a known secret and redacts a home path in lines the server composes (docs/SPEC.md § Outgoing text guard) |
| `src/os-proxy.ts` | Reads the OS proxy / PAC settings (scutil, registry, gsettings) to name them when a direct connection fails; never applies them |
| `src/attach-check.ts` | `metabob-mcp attach --check`: the attachment once, hop by hop, with the named cause; exit 0 when attached |
| `src/auth-service.ts` | Identity-vessel org check (`POST /v1/auth/resolve`, classified) and the key-issuance heartbeat, against the attachment's identity |
| `src/vessel-server.ts` | Hono HTTP server on `127.0.0.1` — `/health` (with the attachment state), `/v2/capabilities`, `POST /v2/impulses/resolve`, for local callers |
| `src/sqlite.ts` | The local store's SQLite under either runtime: `bun:sqlite` under Bun, `node:sqlite` under Node 22.13+, one file and schema; the launcher (`src/cli.ts`) runs the server in-process on such a Node, re-execs into Bun on an older one, and names both fixes with neither (docs/SPEC.md § Runtime) |
| `src/local-index.ts` | Singleton `LocalIndex` wrapping `CoChangePredictor` (the CPG and its components; co-change itself comes from git history, `src/git-cochange.ts`), loaded on the first local-tool call (its native modules sit in a build chunk of their own; one that cannot load gives `local_index_unavailable(<module>: …)`), backed by the vendored CPG fork under `vendor/cpg-inference` (re-exported by `src/cpg-inference.ts`; not an npm dependency). Rebuilt in-memory per process launch — the CPG/index is not persisted across restarts (re-run `init_workspace`) |
| `src/tools/index.ts` | Tool registry — maps tool names to handlers |
| `src/tool-allowlist.ts` | Which tools the server lists (`METABOB_TOOLS`): the default set, `all`, or a comma list (docs/SPEC.md § Tool sets) |
| `src/server-instructions.ts` | The MCP `instructions` returned from `initialize`, naming only the tools the server lists (docs/SPEC.md § Agent instructions) |
| `src/repo-identity.ts` | The repository a workspace's ledger is keyed by (origin URL, else `root:<first commit>`, else `local:<hash>`), the super-repo/vessel aliases, and the fix location `mark_complete` reads from git (docs/SPEC.md § Repository identity) |
| `src/tools/_findings.ts` | Findings recall and verdicts: the paged concept-db scans (`scanConceptShape`), repository matching, verdicts past the window, duplicate check, seed retirement |
| `src/tools/_records.ts` | The goal tools' records client: the operator gate (identity's `ownerKind` must be `operator`, else nothing is sent), `record_read` / `record_write` with the cross-node refusal named, and an ask's state from its citing rows (`root-status`) |
| `src/tools/_claims.ts` | Claims on findings: the claim lines, the claim-holder rule every reader applies, and the trusted release (`METABOB_CLAIM_RELEASERS`) |
| `src/tools/_concept-db.ts` | concept-db's shapes through the attachment, shared by the concept tools and the ledger, and `stampedWriter`: who wrote a row, for trust (docs/SPEC.md § Written by) |
| `src/cli-attach.ts` | The attachment and vessel identity for the cell CLI steps (`task pull`, `finding close`), as the server sets them at boot |
| `src/task-pull.ts` | `metabob-mcp task pull`: claim a ledger task, write `/task`, clone `/work`, with the integration policy from trusted conventions (docs/SPEC.md § task pull) |
| `src/finding-close.ts` | `metabob-mcp finding close`: close the findings a cell's own commits name (`Fixes-Finding:`) once merged into the target (docs/SPEC.md § finding close) |
| `src/attached-marker.ts` | While the attachment is authenticated, a marker for the workspace in the temp directory (`{pid, orgId, at, tools}`, `tools` being the names the server lists; refreshed each minute, removed on detach or exit), so the plugin's edit check holds edits only where there is a ledger behind it |
| `scripts/claude-plugin/edit-check.mjs` | The Claude Code plugin's edit check (shipped in the generated `plugin/`, README § Agent plugins): before an agent's first edit of an existing file in a session, hold it once and ask for `get_problems` / `path_activity` on it; a file already checked through either tool is not held; a server that does not list `path_activity` (the default tool set, named in its marker) gets holds that ask for `get_problems` only, as does a repository `path_activity` reports unmounted; `METABOB_EDIT_CHECK=off` disables it (README § Claude Code plugin) |
| `scripts/build-plugins.mjs` | Generates both plugin bundles from one source (`scripts/plugins/source.json`, `package.json`, the skills, the edit check): the Claude Code plugin in `plugin/` with `.claude-plugin/marketplace.json`, and the Agent Plugins 1.0 bundle at the root (`plugin.json`, `mcp.json`, `skills/`) with the Codex marketplace `.agents/plugins/marketplace.json`. Both launch the server pinned to this version under an npm alias, so npx fetches it inside a checkout of this repository too. The generated files are committed; edit the source and regenerate (README § Agent plugins) |
| `docs/SPEC.md` | Full tool specification with input/output schemas |
| `docs/links.json` | Docs ↔ code link database, maintained by `scripts/doclinks.mjs` (see `docs/DOCLINKS.md`) |

## Tools

The server lists these tools with `METABOB_TOOLS=all`; unset, it lists the default set (`get_analysis_context`,
`get_problems`, `claim_finding`, `record_finding`, `mark_complete`, the five `concept_*` reads and writes other than
`concept_sequence` and `concept_usage_stats`, and `init_workspace`; docs/SPEC.md § Tool sets).

| Tool | Tier | Key behaviour |
|------|------|--------------|
| `init_workspace` | **Local** | Parses the workspace into the in-process CPG; makes no request. `batch_size` / `sync_api` are accepted and ignored |
| `get_problems` | Local + Substrate | Problems ranked by severity: the local store's seeds (incl. agent-recorded `agf_*` findings) plus a "Findings recorded by agents on this codebase" section recalled from concept-db (`code_finding` concepts, list-mode, filtered client-side to the current repo/files). The recall runs first and retires this session's local seeds of any finding it shows closed, so a verdict recorded by another session leaves the open list here too. Findings in category `task` (work assigned on the ledger) are counted and listed apart, with their claims. States that there is no server-side analysis |
| `record_finding` | Local + Substrate | The write half of agent-side analysis: attribute an agent-noticed issue (files, summary, severity, category, optional lines/details) to code, or, for work that changes no file (investigate, test, review, operate), to a `subject` with no files. Upserts a LocalStore seed (`agf_*` id — surfaces immediately via `get_problems`) and best-effort mints a `code_finding` concept into concept-db so other agents on this codebase recall it, stamped with `recorded_by: <vesselId>` + `session: <sessionId>` in the concept content (the author line is **omitted**, never faked, when no vessel identity resolves). concept-db unreachable = non-fatal, reported in output. |
| `search_codebase` | **Local** | Keyword search over CPG nodes and the local store's findings |
| `predict_cochanges` | **Local** | Git-history co-change mining (`src/git-cochange.ts@mineGitCochanges`): the files that changed in the same commits, each with its confidence and commit count; `confidence_threshold` applies to that confidence. No API call; needs a git checkout, not `init_workspace` |
| `analyze_impact` | **Local** (+ `path_activity`'s cached read, when warm) | BFS over local CPG; shows affected components by depth; when attached, each changed file's open gaps and landing leases |
| `annotate_component` | **Local** | Why/how notes built locally from templates for a problem id held in the local store (`agf_*` findings); any other id is reported as not found, since there is no server-side analysis |
| `mark_complete` | Local + Substrate | Endorse (fixed) or discard (false positive) an `agf_*` or `concept_*` id; any other id is refused, since there are no backend detections. A finding that names no file closes on endorse at once, its `outcome` and `evidence` written on the verdict, and recall lists it `[DONE]`; one that names files closes only by its commit, as follows. An endorse records where the fix is (`fix: commit <sha>` from the checkout's git state); a fix still uncommitted, committed but on no remote branch (in a checkout with a remote), or pushed only to task branches (awaiting merge), leaves the finding open org-wide as `fix pending` and retires nothing; a commit counts only when it postdates the finding and touches its files, or is named with `fix_commit` (an older named commit counts when it touches the finding's files); a file the fix deleted is found through its history, and a finding on ignored files closes as local to the checkout; and recall elsewhere says whether that checkout's HEAD has the fix commit. For agent findings: endorse marks the LocalStore seed stale, discard deletes the **local seed only** (the org-wide `code_finding` concept is never retracted), a `finding_verdict` concept is best-effort recorded to concept-db, and — closing the relevance loop — the verdict is folded directly into the finding concept's relevance via a usage signal (endorse→`success`, discard→`failure`) when the seed carries a linked `concept:` id. Accepts a `concept_*` id too (the form cross-agent recall hands you) and resolves it to its `agf_*` seed via `LocalStore.getSeedByConceptRef`; with no local seed the verdict is written from the recalled concept itself (still keyed on the finding's `agf_*` id) and the output states that nothing local was retired. Both paths stamp the verdict with `reviewed_by: <vesselId>` + `session: <sessionId>` and a separate `origin: local` / `origin: remote` provenance line — author and locality are never folded into one key. |
| `claim_finding` | Substrate | Say you are starting work on a finding (`claim` / `renew` / `release`), so another agent does not start the same work: a `finding_verdict` with `verdict: claimed`, `claim_minutes:` (counted from concept-db's `created_at`) and `claim_until:`. The holder is decided by one rule every reader applies, since concept-db has no compare-and-set: the earliest live claim, the lower concept id on a tie; a claimer that reads back another holder withdraws. Recall shows `[claimed by … until …]`; a verdict that closes the finding ends it (a pending endorse does not), and the server releases the claims it took through the tool when it shuts down normally, including one whose read-back did not settle once a second call confirms it (`src/tools/claim-finding.ts@session-claims`; `task pull`'s claim outlives its process). A key named in `METABOB_CLAIM_RELEASERS` (as the host stamps `written_by`) may release someone else's claim with a `reason`, which readers that name it take as the end of that claim |
| `get_metrics` | **Local** | Open findings in the local store by severity, source and category, plus the local CPG size; makes no request and states that there is no server-side analysis |
| `assign_git_changes` | **Local** (+ `path_activity`'s cached read, when warm) | Maps changed files → CPG components + git-history co-changes + local-store findings in those files; when attached, each file's open gaps and landing leases |
| `get_analysis_context` | Local + Substrate | Snapshot of CPG stats + open problems from the local store + git-history co-changes of recently changed files + compact top-5 recall of other agents' recorded findings for this codebase |
| `run_goal` | Substrate | Ask the walk and **wait** a while: writes the ask as `run_goal_async` does, then short `record_read { refs_to }` polls until an answer cites it or the polling deadline `RUN_GOAL_TIMEOUT_MS` (default 290 s) passes; answers with the ask's state as `goal_status` gives it. |
| `run_goal_async` | Substrate | Ask the walk: writes the goal as a records `world_changed` row (`record_write`) under the cockpit's own operator sign-in; the stored row's id is the `dispatchId`. Under a key identity does not mark `operator` (the shared key included) it writes nothing and says it waits on that sign-in, issued by the USER on the human surface (`src/tools/_records.ts@operator-gate`). |
| `goal_status` | Substrate | The ask's state from records: open, or closed reached (a person's counted r 1 on an answer) or failed (a counted lapse on its deadline); each answer with its grades and their standing, and the deadline's `at` as stored, with no lapse drawn from it here. |
| `goal_reasoning` | Substrate | How the walk worked an ask: its moves (`selection` rows: what it chose, the candidates and the posteriors drawn), the failures on those moves with their blames, and its calls in order. |
| `provide_feedback` | Substrate | An operator's note on an ask's answer: an `outcome` row (`r` 1/0/0.5 from `reached`/`not_reached`/`partial`, `why` from the rationale). The reply says it is not a verdict: it closes nothing and moves no posterior; a person's grade on the human surface does. |
| `path_activity` | Substrate | Before editing shared files: the open gaps naming each path (edit site, a file the gap names, directory, mention), each marked held by an operator ruling (with review date) or queued for the system, with a landing lease shown only if a gap row still carries one. Maps workspace paths to the store's `repos/<vessel>/…` form; reads records' gap rows with one constant pointer (`record_read { shape: "gap", stored: true }`), keeps the detector's newest row per gap, drops any other row, and says a failed read as such; cached per attachment: fresh 5 min, then served stale while one background read refreshes it |
| `registry_query` | Substrate | Inspect discovery-vessel's registry without host access, through discovery's own shapes. `mode:"shapes"` lists the advertised shape vocabulary — the union of `vesselRegistry`'s vessel shapes (optional `shape` substring filter, applied client-side); `mode:"vessels"` (requires `shape`) lists vessels advertising a shape (vesselId, endpoint, protocol, resolve_endpoint) via `vesselCapability`. |
| `execution_trace` | Substrate | The walk's work from records: with no `execution_id`, its recent moves, newest first (the ask each worked, what it chose); with one, that call (type, state, the ask, its output) or else the row with that id. |
| `resolve_impulse` | Substrate | ADVANCED escape hatch: the attachment's `resolve()` for any shape — `{ pointer }` to discovery `POST /resolve` — instead of a raw `curl`; it refuses none, since what a key may do is each producer's decision (e.g. records-vessel stamps a `record_write` as the key's, role person). A known read (`src/tools/resolve-impulse.ts@known-reads`) is sent as a read: retried when cut at its producer's timeout, except the trace reads (`activityExecutionTrace`, `executionTraceList`, `executionTraces`), and allowed with a read-only key; any other shape may be a write, so it is sent once and never retried (docs/SPEC.md § resolve_impulse). Prefer the dedicated tools when they fit. |
| `concept_*` | Substrate | concept-db graph: `concept_search` / `_neighbors` / `_usage_stats` / `_sequence` / `_link` / `_create` / `_record_usage`. `concept_create` stamps the author first in the content (`recorded_by: <vesselId>`, `session:`), removes author and provenance lines (`recorded_by`, `reviewed_by`, `session`, `origin`) the agent wrote in the header block, with or without an identity, and refuses the ledger's shapes (`code_finding`, `finding_verdict`). See docs/SPEC.md § Concept graph tools. |
| `concept_record_usage` | Substrate | The direct write into concept-db's **relevance** model — the `conceptUsage_write` shape. Attribute an outcome to a concept you used: `success` credits it (raises relevance), `failure`/`neutral` grow the load count without credit. concept-db folds it into the Bayesian posterior mean `(times_succeeded+1)/(times_loaded+2)`. Reads through `conceptSearch` / `conceptGraph` record no load, so this is how a concept the agent relied on gets credit. |

**Substrate tools** (`run_goal*`, `goal_status`, `goal_reasoning`, `provide_feedback`, `path_activity`, `registry_query`, `execution_trace`, `resolve_impulse`, `claim_finding`, `concept_*` incl. `concept_record_usage`, and the substrate half of `record_finding` / `get_problems` / `get_analysis_context` / `mark_complete`) reach the substrate through **one ingress**: each operation is a shape resolved through discovery `POST /resolve` (`src/attachment.ts@attachment-resolve`), which picks the shape's producer — records (`record_write`, `record_read`), concept-db (`conceptSearch`, `conceptGraph`, `concept_create_write`, …), the gap store (`substrateGap`) or discovery itself (`vesselRegistry`, `vesselCapability`) — and forwards the pointer with the key. No service URL is configured, derived or discovered for a call; the one exception is `concept_usage_stats`'s recent rows, which no shape serves (CONFORMANCE §c11). Discovery's own failures are one named line (`no_producer(shape)`, `producer_timeout(shape, ms)`, …), and so is the network's (`proxy_auth_required(NTLM)`, `tls_intercepted(issuer)`, `connect_timeout(host:port)`, …: docs/SPEC.md § Network); every request is capped at 60 s, and reads cut at a producer's timeout are retried. Config resolution is directory-aware, like git: `SUBSTRATE_CONFIG_PATH` → `METABOB_CONFIG_PATH` → `./.substrate/config.json` → `./.metabob/config.json` (launch directory; lets a project pin its own backend; a file without a `metabob` section, such as another tool's, is skipped with a warning) → `~/.substrate/config.json` (what the installer writes) → `~/.metabob/config.json`. A local substrate endpoint (`http://127.0.0.1:18080`, what the installer writes) needs only `metabob.apiKey` + `metabob.endpoint` — it derives `DISCOVERY_ENDPOINT=…:18100` (census class H1 interim debt, warned about once at startup); any other endpoint (https, or an `http://` one with no explicit port ending in 80) derives **nothing**, so such a substrate needs an explicit `DISCOVERY_ENDPOINT` / `metabob.discoveryEndpoint`. An explicit `METABOB_ENDPOINT` takes only the credentials from a config file, never its endpoints, so the two can't split across substrates.

**The surface is a complete operator cockpit — no host access needed.** Three planes + a coverage set: ACT (`run_goal*`), TRACK (`goal_status`), REASON (`goal_reasoning`), FEEDBACK (`provide_feedback`), INSPECT (`registry_query` / `execution_trace` / `resolve_impulse`). The last three replace `docker exec` / `journalctl` / raw `curl` for reading the running substrate. Canonical loop:

```
run_goal_async({ goal })        → dispatchId    (name a repos/<vessel>/src file for a code change)
goal_status({ dispatch_id })    → open, or closed reached / failed, with its answers and grades
goal_reasoning({ dispatch_id }) → the walk's moves, failures and calls
provide_feedback({ dispatch_id, verdict, rationale })  → an operator's note on the answer, not a verdict
```

**The goal tools are records' rows** (docs/SPEC.md § Substrate goal tools; `src/tools/_records.ts`), each read and write resolved through discovery `POST /resolve`:
- An ask is `record_write { row: { shape: "world_changed", what } }`. records stamps a row's role from the class identity marks the key with (`ownerKind`, read by the org check); an operator's row is an ask the walk takes as a root. The ask's row id is the `dispatchId`.
- Its state is the rows citing it (`record_read { refs_to }`): answers, the deadline row, and the `outcome` grades with the `standing` records gives them; whether it is open comes from records (its calls' `open`, else the walker's episode read).
- The goal tools wait on the cockpit's own operator sign-in, issued by the USER on the human surface: under any other key they send nothing to records and say so. The mark is re-checked at most every 15 min (each org check writes a key-session row on identity). An operator's key writes on its own node; when records refuses a write from another node, the tool says to attach to the walk's node.
- The goal text is sent unchanged; a goal that names a real `repos/<vessel>/src/…` file is a code change for the walk. Read the answer before noting it: an answer can be given without doing what was asked.

## Impulse shapes resolved (HTTP)

Resolver endpoint: `POST /v2/impulses/resolve` on `127.0.0.1` — `Authorization: ApiKey <METABOB_API_KEY>`, local callers only; nothing advertises it. The shape → tool map lives in docs/SPEC.md § Impulse shapes (HTTP resolver).

## Environment variables

**The configuration is two values: `METABOB_API_KEY` and `METABOB_ENDPOINT`** (or `metabob.apiKey` and
`metabob.endpoint` in a config file — the installer writes both into `~/.substrate/config.json`, which
`~/.metabob/config.json` links to; the installer's env names `SUBSTRATE_API_KEY` / `SUBSTRATE_ENDPOINT`
are accepted too; the key may instead be read from another JSON file, `metabob.apiKeyFile: { path, field }`,
docs/SPEC.md § Config-file schema). Neither has a default. Proxy and trust are never configuration: they come from the
environment (`HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`) and the OS trust store. When the server
does not attach, run `metabob-mcp attach --check` first. With either missing the server starts with local
tools only and logs one message naming the missing input and the config lookup order
(`src/config.ts@unattachedMessage`). An `http://` endpoint on a port ending in 80 derives discovery at its
port offset; any other endpoint derives nothing, and discovery is set explicitly. No other service URL is configuration: every
substrate call resolves a shape through discovery. The remaining variables are advanced overrides — each
wins over its derived value only when set explicitly.

| Variable | Default | Purpose |
|----------|---------|---------|
| `METABOB_API_KEY` | — | API key — sent as `Authorization: ApiKey` on every substrate request; validates calls to the loopback resolver |
| `METABOB_ENDPOINT` | — | Substrate endpoint. An `http://` endpoint on a port ending in 80 (`…:18080`) derives discovery at the block's …100 (`:18100`); any other derives nothing. Env-var mirror of `metabob.endpoint` |
| `SUBSTRATE_API_KEY`, `SUBSTRATE_ENDPOINT` | — | The installer's names for the key and endpoint; fill `METABOB_*` when unset. When both are set and differ, `METABOB_*` wins, with one warning |
| `SUBSTRATE_CONFIG_PATH`, `METABOB_CONFIG_PATH` | — | Config file to read (in that order) instead of the lookup `./.substrate` → `./.metabob` → `~/.substrate` → `~/.metabob` (`config.json` in each) |
| `HTTPS_PROXY`, `HTTP_PROXY` | — | HTTP CONNECT proxy, chosen per request: https uses `HTTPS_PROXY` (falling back to `HTTP_PROXY`), http uses `HTTP_PROXY`; lowercase names win. Basic credentials go in the URL and are redacted everywhere they are reported. PAC / WPAD is not evaluated: set the proxy it names |
| `NO_PROXY` | — | Hosts that go direct (`*`, host and subdomains, `host:port`, IPv4 CIDR). Whenever a proxy is set, `localhost`, `127.0.0.1` and `::1` are added, and every loopback host goes direct |
| `NODE_EXTRA_CA_CERTS` | — | Extra trusted roots (PEM), on top of the bundled roots and the OS store; read by the server itself, so it applies under Bun too |
| `METABOB_CONNECT_TIMEOUT_MS` | `5000` | Connect budget (TCP connect, proxy `CONNECT`, TLS handshake), separate from each call's response budget |
| `METABOB_NO_SYSTEM_CA` | _(unset)_ | `1` skips the OS trust store (also `--no-system-ca`) |
| `DISCOVERY_ENDPOINT` | _(derived)_ | The anchor: discovery-vessel base URL (also `metabob.discoveryEndpoint`, the preferred form). Required with an endpoint that derives none; derived from an `http://…80` one with a WARN naming census class H1 |
| `IDENTITY_ENDPOINT` | _(from `/bootstrap`)_ | Advanced: identity vessel for the org check, overriding the `identity_endpoint` discovery's `/bootstrap` advertises |
| `IDENTITY_API_KEY` | — | Advanced: a second key the loopback resolver accepts from local callers, besides `METABOB_API_KEY` |
| `RUN_GOAL_TIMEOUT_MS` | `290000` | `run_goal`'s polling deadline: how long it waits for an answer to its ask before handing back its `dispatchId` |
| `RUN_GOAL_POLL_MS` | `2000` | Pause before `run_goal`'s first three reads of the rows citing its ask; later pauses double up to `RUN_GOAL_POLL_MAX_MS` |
| `RUN_GOAL_POLL_MAX_MS` | `15000` | Longest pause between `run_goal`'s reads of the rows citing its ask |
| `RESOLVE_IMPULSE_TIMEOUT_MS` | `30000` | `resolve_impulse`'s request cap (never above 60 s) |
| `WORKSPACE_PATH` | _(the client's first root, else `$PWD`)_ | The workspace: which repository the ledger is keyed by and where the store scopes findings. An `init_workspace` path wins over it, and it wins over the client's MCP roots. A `$PWD` inside `PLUGIN_ROOT` (an Agent Plugins client's own plugin folder) is no workspace: tools answer `workspace_undetermined` until `init_workspace` names one (docs/SPEC.md § Workspace) |
| `PLUGIN_ROOT` | _(set by an Agent Plugins host)_ | The plugin's own folder; a launch directory inside it is no workspace (`src/local-index.ts@workspace-gate`, docs/SPEC.md § Workspace) |
| `SESSION_ID` | _(fresh UUID per launch)_ | Session identifier, declared on every write (`client_claim.session`) |
| `HEALTH_PORT` | _(ephemeral)_ | Port of the loopback HTTP resolver. No fixed default: concurrent instances would collide, and 8000–8999 are substrate container ports (8080 is activity-api). Warns if set in that range |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error`: the log (stderr) writes the lines at or above this level (debug < info < warn < error); an unknown value reads as `info`. `--log-level` sets the same |
| `METABOB_STDIO_KEEPALIVE` | _(unset)_ | Set to `1` to survive stdin EOF and a closed stdout — headless operation (the loopback HTTP resolver only). Otherwise the process exits when stdin ends or stdout closes, so an orphaned server does not outlive its MCP client; `SIGINT`, `SIGTERM` and `SIGHUP` always shut it down |
| `MAX_REQUESTS_PER_MINUTE` | `60` | MCP rate limit per session |
| `METABOB_TOOLS` | _(unset → the default set)_ | Which tools the server lists, on stdio and on the loopback resolver (docs/SPEC.md § Tool sets): unset, the eleven of the shared ledger and memory (`src/tool-allowlist.ts@default-tool-set`); `all`, every tool in the table above; a comma list, exactly those. Sessions working on this repository run with `all` |
| `METABOB_EDIT_CHECK` | _(on)_ | `off` disables the Claude Code plugin's edit check (README § Claude Code plugin); `METABOB_EDIT_CHECK_DIR` moves its per-session state and `METABOB_MARKER_DIR` the server's attached marker from the temp directory |
| `METABOB_CALL_LOG` | _(unset)_ | A file to append one JSON line per tool call to, on stdio and the loopback resolver (tool, argument names and sizes, outcome, the tool's result kind, duration; never a value), for scoring call order in any harness. Local only, mode 0600 (docs/SPEC.md § Call log) |
| `METABOB_CLAIM_RELEASERS` | _(unset: none)_ | Comma-separated keys (by id, or name, as the host stamps `written_by_key` / `written_by`; a vessel id matches only rows from before the stamp) this server trusts to release a claim someone else holds (a manager freeing a stalled task). Set the same list on every server of a fleet: readers with different lists disagree on who holds a task (docs/SPEC.md § claim_finding) |
| `METABOB_TASK_TRUST` | _(the task's recorder)_ | `task pull`: comma-separated keys (by id, or name, as the host stamps `written_by_key` / `written_by`; a vessel id matches only rows from before the stamp) whose `project_convention` concepts may set a task's integration policy; a row from before the stamp is read by its declared `recorded_by` (docs/SPEC.md § task pull, § Written by) |
| `METABOB_TASK_KINDS` | _(every kind)_ | `task pull`: comma-separated kinds of task to take, by the first `Kind:` line among the brief's leading key lines (a brief with none is `change`); same as `--kinds` (docs/SPEC.md § task pull) |
| `METABOB_CLIENT_CLAIM` | _(on)_ | `off` stops adding `client_claim { operator, session, client }` to every write's pointer (docs/SPEC.md § Client claim) |
| `MB_OPERATOR_ID` | _(this workspace's vesselId)_ | Operator identity declared on every write (`client_claim.operator`); unset, the stable `metabob-mcp-<hash>` vesselId, so sessions in different workspaces never share one default |
| `VESSEL_ID` | _(derived)_ | The coordination identity: the `recorded_by` / `reviewed_by` author of findings and verdicts. Defaults to a stable `metabob-mcp-<hash(apiKey+workspace)>`. Never registered anywhere |

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
- **No dispatched work.** The substrate dispatches nothing to the session and the walk never waits on it:
  the loopback resolver refuses `human_input` as an unknown shape, and the server keeps no task queue.

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
(the one ingress: forwards each      (Tree-sitter parse,              (/health, /v2/capabilities,
 shape to records, concept-db,      code property graph)             /v2/impulses/resolve)
 goal-host; identity from
 /bootstrap, org check first)
```

## Related

- [docs/SPEC.md](docs/SPEC.md) — full tool specification
- [docs/DOCLINKS.md](docs/DOCLINKS.md) — the docs ↔ code link database and its checks
- [docs/CONFORMANCE.md](docs/CONFORMANCE.md) — the substrate participation requirements this vessel answers to, and which it meets
- [vendor/cpg-inference](vendor/cpg-inference/) — vendored CPG fork (Tree-sitter parsing, the code property graph)
