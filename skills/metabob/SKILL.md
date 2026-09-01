---
name: metabob
description: Manage a codebase with the Metabob MCP server as its code-intelligence sidecar — the agent does the sequencing, Metabob holds the structure. Encodes the working protocol for any repository (not only substrate repos): adopt a codebase into the Code Property Graph via incremental sync batches, keep the map current while editing, see blast radius before changes (impact analysis + co-change prediction), triage ranked problems asynchronously, and close the loop with detection feedback and durable design memory shared across every client in the org. Use at the START of any coding session where Metabob is connected, and follow its cadence throughout — before editing shared code, after batches of edits, and at commit/close-out time.
---

# Metabob: agent-driven codebase management

Metabob reasons over the *structure* of a codebase — a Code Property Graph (CPG) —
not just its text. The division of labor is deliberate: **the agent (you) does all
sequencing and spends the tokens; the server just holds the map and the org's
shared learning.** Nothing orchestrates you from the outside. Follow this protocol
and any repository — substrate-compliant or not — becomes a managed codebase.

Every call below is one MCP tool call. `predict_cochanges` and `analyze_impact`
are local-tier — no API traffic; sync, triage, and `search_codebase` with
`target: "problems"` hit the org's analysis service.

## Phase 0 — Recall before you explore (session start, 3 calls)

1. `concept_search { query: "<repo name> <task area>" }` — the org's design memory.
   Another agent (or a past you) may have recorded exactly the constraint or
   gotcha you're about to rediscover. Recall is ~100 tokens; rediscovery is
   thousands. **Note the repo's anchor concept id** (`shape: "repo_anchor"`) if
   one comes back — Phase 4 links to it. If semantic search errors or times
   out, fall back to filter mode (`shape` / `source_type`, no `query`) rather
   than retrying the query.
2. `get_analysis_context` — structure snapshot, open problems, co-change
   signals, and findings other agents recorded on this codebase.
3. `pull_assigned_work` — decisions the substrate dispatched to this vessel,
   including ones assigned while you were away; answer each with
   `submit_resolution { task_id, outcome, answer }`. An unanswered task blocks
   a goal-host walk.

Only after these do you start reading files.

## Phase 1 — Adopt or resume the codebase

Run `init_workspace { workspace_path, recently_changed_files: [...] }` with the
files from `git status` + the last few commits. Then **read the output — it drives
the loop**:

```
API sync
  Status:   pending (job: …) — 177 files not yet submitted (call again to continue)
  Progress: 37/214 files submitted
```

- **Resuming** (progress near total): one call is enough; move on.
- **Adopting** (fresh repo, low progress): loop `init_workspace { batch_size: 20 }`
  while the output says *"call again to continue"*. Each call is one batch —
  submission order is relevance-ranked, so the important files go first.
  **Interleave the loop with your other startup work** (reading code, planning);
  don't sit and drain it serially unless the repo is small. Do NOT wait for
  analysis results — analysis is asynchronous; results are picked up in Phase 3.
- The CPG and the submitted-file set live in the MCP server process. A fresh
  session needs a fresh `init_workspace`, and submission restarts from the top
  of the relevance ranking (local re-index is fast).

## Phase 2 — Working cadence (the loop you maintain)

**Before editing anything shared or unfamiliar** (2 local calls, no API cost):

- `analyze_impact { changed_files }` — what the change reaches.
- `predict_cochanges { changed_files }` — what historically moves together with
  it. This catches the sibling file you'd otherwise forget.

**After every ~3–5 edited files**: one `init_workspace { recently_changed_files:
<the files you just edited> }` call. One batch, a few seconds — this is how the
server's map stays current and your edits enter the analysis pipeline. Treat it
like saving your work.

**When you notice an issue while working** (a bug, a security risk, a design
constraint, a gotcha tied to specific code): `record_finding { files, summary,
severity, category }` immediately — you are the detector now; the server
attributes your observation to the code, surfaces it via `get_problems` and
shares it org-wide so other agents on this region see it. Don't hold findings
in your head until close-out.

**When hunting**: `search_codebase { query }` (token match over CPG component
names, file paths and problem summaries — not semantic) and
`concept_neighbors` / `concept_sequence` when a recalled concept is nearby.

## Phase 3 — Asynchronous triage (poll, never block)

Analysis lags submission by design. On a natural pause — not immediately after a
sync — run:

- `get_problems { limit, severity }` — ranked findings: the local detection
  cache plus **findings recorded by agents on this codebase** (a distinct
  section). Agent findings are the primary source; server-side detection is
  deprecated and may be absent.
  Treat other agents' findings as first-class — they were noticed by an LLM
  working the same region.
- `annotate_component { problem_id }` — explanation or concrete fix for one you
  intend to act on. Skip annotation for problems you won't touch this session.

Fold real findings into your work queue like any other task.

## Phase 4 — Close-out (mandatory, this is where org learning happens)

Before committing / ending the session, in order:

1. `init_workspace { recently_changed_files: <final edits> }` — last sync batch.
2. `assign_git_changes { changed_files }` — maps your diff to affected components + predicted
   co-changes. If it names a file you didn't touch, check it before committing.
3. `record_finding` for anything you noticed but did not fix — attributed,
   open findings survive the session and reach the next agent.
4. `mark_complete` for **every** problem you resolved (endorse) or disproved
   (discard), including the `agf_*` findings you recorded. Verdicts are shared
   org-wide. Pass the `concept_*` id when that is all you hold — a finding
   recalled from another machine is **not** read-only here: with no local seed
   the verdict is written from the recalled concept itself (keyed on the
   finding's `agf_*` id), and the output says plainly that nothing local was
   retired. That is the fleet case the call exists for — one agent records, a
   second fixes — so do not skip it. Not optional bookkeeping.
5. `concept_create` for each non-obvious thing you learned (why an approach was
   chosen, a constraint, a gotcha). Use `source_type: "memo"` for findings,
   `"human_input"` for things the user told you. **Then `concept_link` it to
   the repo's anchor concept — not optional.** An unlinked concept is only
   findable by semantic search; a linked one is reachable from the anchor by
   any future session. You noted the anchor id in Phase 0; if none exists,
   create it first (see below), then link. Then `concept_record_usage
   { concept_id, outcome }` on each Phase 0 recall that actually helped
   (`success`) or misled you (`failure`) — the direct write into concept
   relevance; without it recall quality never improves.
6. If you dispatched substrate goals this session: `goal_reasoning` on each
   dispatch, then `provide_feedback { verdict, rationale }` — your verdict
   calibrates goal routing for the whole org.

## Arbitrary (non-substrate) codebases

Everything above works on any TS/JS/Python repository — the CPG, impact, co-change,
problems, and concepts need no substrate compliance. The inversion to remember:
**you are the actuator**. The substrate's `run_goal*` edit path only lands commits
in repos the goal-host mounts; on arbitrary repos, you make the edits yourself and
Metabob is your perception and memory. The learning still synchronizes org-wide.

To keep the shared concept graph navigable across many repos:

- On first adoption, `concept_search` for an anchor concept named after the repo;
  if absent, `concept_create { content: "<repo name>: <one-line purpose, root path,
  primary language>", shape: "repo_anchor" }`.
- `concept_link` session learnings to that anchor so recall in a later session
  (`concept_search "<repo name> …"`) pulls the repo's whole memory neighborhood.

## Budget discipline

- Recall (Phase 0) and pre-edit checks (Phase 2) are cheap and prevent expensive
  mistakes — never skip them to save tokens.
- The adoption loop (Phase 1) is the main token spend; it is intentionally on the
  agent side. Scale it to the session: full drain for a repo you'll work in all
  day, top relevance batches only for a drive-by fix.
- Annotation (`annotate_component`) only for problems you'll act on.
- One `get_metrics` at close-out if you want a health sanity check; skip otherwise.
