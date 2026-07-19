---
name: metabob
description: Drive the Metabob MCP server as a codebase's code-intelligence sidecar and the org's shared memory — the agent does the sequencing, Metabob holds the structure, the relevance economy, and (for substrate repos) the goal cockpit. Encodes the working protocol for any repository: adopt a codebase into the Code Property Graph via incremental sync batches, keep the map current while editing, see blast radius before changes (impact analysis + co-change prediction), triage ranked problems asynchronously, record findings and verdicts, and contribute to the org's durable, relevance-ranked concept memory so it stays useful across every client. Use at the START of any coding session where Metabob is connected, and follow its cadence throughout — before editing shared code, after batches of edits, and at commit/close-out.
---

# Metabob: agent-driven codebase management

Metabob reasons over the *structure* of a codebase — a Code Property Graph (CPG) —
not just its text, and over the *org's shared memory* — a relevance-ranked concept
graph. The division of labor is deliberate: **the agent (you) does all sequencing
and spends the tokens; the server holds the map, the shared learning, and (for
substrate repos) the goal-execution cockpit.** Nothing orchestrates you from the
outside — the pull surfaces (`get_problems`, `get_analysis_context`) are an
*agenda* you choose to follow, not commands.

Every call below is one MCP tool call. Local-tier calls (`predict_cochanges`,
`analyze_impact`, `search_codebase` structural half) cost no API traffic; sync and
triage calls hit the org's analysis service; `concept_*` and the goal cockpit talk
to the substrate.

## The tool surface at a glance

- **Adopt / perceive**: `init_workspace`, `get_analysis_context`, `search_codebase`
- **Look before you leap** (local, free): `analyze_impact`, `predict_cochanges`, `assign_git_changes`
- **Triage**: `get_problems`, `annotate_component`, `get_metrics`
- **Contribute back** (org memory): `record_finding`, `mark_complete`, `concept_create`, `concept_link`, `concept_record_usage`
- **Recall** (org memory): `concept_search`, `concept_neighbors`, `concept_sequence`, `concept_usage_stats`
- **Substrate goal cockpit**: `run_goal`, `run_goal_async`, `goal_status`, `goal_reasoning`, `provide_feedback`
- **Inspect the running substrate**: `registry_query`, `execution_trace`, `resolve_impulse`

## Phase 0 — Recall before you explore (session start, 2 calls)

1. `concept_search { query: "<repo name> <task area>" }` — the org's design memory.
   Another agent (or a past you) may have recorded exactly the constraint or gotcha
   you're about to rediscover. Recall is ~100 tokens; rediscovery is thousands.
   **Note the repo's anchor concept id** (`shape: "repo_anchor"`) if one comes back
   — Phase 4 links to it. If semantic search errors or times out, fall back to
   filter mode (`shape` / `source_type`, no `query`).
2. `get_analysis_context` — structure snapshot, open problems, co-change signals,
   and a compact recall of findings other agents recorded on this codebase.

Only after both do you start reading files.

## Phase 1 — Adopt or resume the codebase

Run `init_workspace { workspace_path, recently_changed_files: [...] }` with the
files from `git status` + the last few commits. Then **read the output — it drives
the loop**:

```
Progress: 37/214 files submitted
Status: pending (job: …) — 172 files not yet submitted (call again to continue)
```

- **Resuming** (progress near total): one call is enough; move on.
- **Adopting** (fresh repo, low progress): loop `init_workspace { batch_size: 20 }`
  while the output says *"call again to continue"*. Submission order is
  relevance-ranked, so important files go first. **Interleave the loop with your
  other startup work** (reading code, planning); don't drain it serially unless the
  repo is small. Analysis is asynchronous — don't wait for results here; pick them
  up in Phase 3.
- The CPG lives for the MCP server session and is **rebuilt in memory per launch
  (not persisted)** — a fresh session needs a fresh `init_workspace` (local
  re-index is fast; already-submitted files aren't resubmitted).

## Phase 2 — Working cadence (the loop you maintain)

**Before editing anything shared or unfamiliar** (2 local calls, no API cost):

- `analyze_impact { changed_files }` — what the change reaches (dependents / blast
  radius over the import graph).
- `predict_cochanges { changed_files }` — what historically moves together with it.
  The primary signal is **git-history co-change mining** (files that change in the
  same commits); a secondary GCN pass adds a name-similarity ranking. This catches
  the sibling file you'd otherwise forget.

**After every ~3–5 edited files**: one `init_workspace { recently_changed_files:
<the files you just edited> }` call. One batch, a few seconds — this keeps the
server's map current and feeds your edits into analysis. Treat it like saving.

**When you notice an issue while working** (a bug, security risk, design
constraint, gotcha tied to specific code): `record_finding { files, summary,
severity, category }` immediately — you are the detector; the server attributes
your observation to the code, surfaces it via `get_problems`, and mints a
`code_finding` concept so other agents on this region recall it org-wide. Don't
hold findings in your head until close-out.

**When hunting**: `search_codebase { query }` (structural, not string match); and
`concept_neighbors` / `concept_sequence` when a recalled concept is nearby.

## Phase 3 — Asynchronous triage (poll, never block)

Analysis lags submission by design. On a natural pause — not right after a sync —
run:

- `get_problems { limit, severity }` — severity-ranked findings: local detections
  plus a distinct **"findings recorded by agents on this codebase"** section
  (recalled from concept-db, paginated past the top window). Treat other agents'
  findings as first-class — an LLM working the same region noticed them.
- `annotate_component { problem_id }` — explanation or concrete fix for one you
  intend to act on. Skip annotation for problems you won't touch.

Fold real findings into your work queue like any other task.

## Phase 4 — Close-out (mandatory — this is where org learning happens)

Before committing / ending the session, in order:

1. `init_workspace { recently_changed_files: <final edits> }` — last sync batch.
2. `assign_git_changes` — maps your diff to affected components + predicted
   co-changes. If it names a file you didn't touch, check it before committing.
3. `record_finding` for anything you noticed but did not fix — attributed, open
   findings survive the session and reach the next agent.
4. `mark_complete` for **every** problem you resolved (`endorse`) or disproved
   (`discard`) — including your own and other agents' `agf_*` findings. For agent
   findings this also folds the verdict into the finding concept's **relevance**
   (endorse → success, discard → failure), so a validated finding gains standing
   and a false positive loses it. Not optional bookkeeping.
5. `concept_create` for each non-obvious thing you learned (why an approach was
   chosen, a constraint, a gotcha). `source_type: "memo"` for findings,
   `"human_input"` for things the user told you. **Then `concept_link` it to the
   repo's anchor concept — not optional.** An unlinked concept is only findable by
   semantic search; a linked one is reachable from the anchor by any future
   session. You noted the anchor id in Phase 0; if none exists, create it (below),
   then link.
6. `concept_record_usage` on the concepts that actually earned their keep this
   session — see "The relevance economy" below.
7. If you dispatched substrate goals: `goal_reasoning` on each dispatch, then
   `provide_feedback { verdict, rationale }` (see the cockpit section).

## The relevance economy (why writing back is structural, not etiquette)

concept-db ranks every concept by a Bayesian success rate,
`relevance = (times_succeeded + 1) / (times_loaded + 2)`. Two consequences shape
how you must behave:

- **Loading a concept deflates it.** Every `concept_search` / `get_analysis_context`
  recall fires a *neutral* usage event server-side (`times_loaded += 1`, no
  credit), pulling relevance toward the 0.5 prior. Merely being surfaced is a
  weak-negative — a concept only *rises* when a real outcome is attached on top of
  the load. So the graph is self-deflating: knowledge that isn't earning credit
  sinks and stops being recalled.
- **You are a first-class credit source.** `concept_record_usage { concept_id,
  outcome }` writes directly into that formula: `success` credits a concept whose
  guidance led to a good result (raises relevance), `failure` penalizes one that
  misled you, `neutral` just registers a load. Use it deliberately at close-out on
  concepts that materially helped — a recalled constraint you acted on, a pattern
  that worked. This is how the org's memory learns what is *actually* useful rather
  than merely present. (`mark_complete` on findings and completed goal executions
  feed the same chokepoint automatically.)

Rule of thumb: if a recalled concept changed what you did and the outcome was good,
`concept_record_usage { outcome: "success" }` it before you close out. Left
uncredited, your own reliance on it quietly lowers its rank for the next agent.

## The substrate goal cockpit (substrate repos)

For repos the substrate can execute against, you can dispatch work as a
natural-language goal and let the substrate decompose and run it. Five planes:

- **ACT** — `run_goal_async { goal }` (returns a `dispatchId`; default for
  non-trivial goals) or `run_goal { goal }` (synchronous, ~290s cap, short goals).
  Send the goal in plain language; decomposition is the substrate's job. The one
  exception: for a code change, **name a real `repos/<vessel>/src/...` file in the
  goal** — that routes it through the edit path that drafts, typecheck-verifies, and
  lands a real commit.
- **TRACK** — `goal_status { dispatch_id }`. **Read `reached`, not `status`.**
  `status` is only the template's exit code; `reached` is the honest goal verdict.
  A hollow `completed`+`reached:false` and a satisfier `failed`+`reached:true` are
  both normal — trusting `status` misjudges the outcome. For anything high-stakes,
  also read the actual diff/output: a change can pass the reach-gate yet not do what
  you asked — that check is yours.
- **REASON** — `goal_reasoning { dispatch_id }`: the walk decision-log — why it
  reached or fell short, per-task resolver/tier, shapes consumed→produced.
- **FEEDBACK** — `provide_feedback { dispatch_id, verdict, rationale }`: records a
  ground-truth label (`reached` / `not_reached` / `partial`) into the oracle
  corpus. Note: this is currently retained for **offline audit** — it is not yet
  consumed by an automated reach-gate recalibration path, so treat it as measured
  ground truth you're banking, not a live tuning knob.
- **INSPECT** — `registry_query` (what shapes exist / who serves them),
  `execution_trace { execution_id }` (durable trace by id), `resolve_impulse`
  (advanced: resolve any impulse shape). These replace `docker exec` / `curl` for
  reading the running substrate — no host access needed.

Canonical loop: `run_goal_async` → `goal_status` (read `reached`) → `goal_reasoning`
→ `provide_feedback`.

## Arbitrary (non-substrate) codebases

Everything in Phases 0–4 works on any TS/JS/Python repository — CPG, impact,
co-change, problems, and concepts need no substrate compliance. The inversion to
remember: **you are the actuator.** The `run_goal*` edit path only lands commits in
repos the goal-host mounts; on arbitrary repos you make the edits yourself and
Metabob is your perception and memory. The org-wide learning still synchronizes.

To keep the shared concept graph navigable across many repos:

- On first adoption, `concept_search` for an anchor named after the repo; if
  absent, `concept_create { content: "<repo name>: <one-line purpose, root path,
  primary language>", shape: "repo_anchor" }`.
- `concept_link` session learnings to that anchor so a later `concept_search
  "<repo name> …"` pulls the repo's whole memory neighborhood.

## Budget discipline

- Recall (Phase 0) and pre-edit checks (Phase 2) are cheap and prevent expensive
  mistakes — never skip them to save tokens.
- The adoption loop (Phase 1) is the main token spend and is intentionally on the
  agent side. Scale it: full drain for a repo you'll work in all day, top relevance
  batches only for a drive-by fix.
- `annotate_component` only for problems you'll act on.
- `concept_record_usage` is nearly free and compounds — credit what helped.
- One `get_metrics` at close-out for a health sanity check; skip otherwise.
